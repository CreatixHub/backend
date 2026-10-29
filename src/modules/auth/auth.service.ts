import { Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import { prisma } from "../../db";
import { HttpError } from "../../lib/errors";
import { sha256 } from "../../lib/hash";
import {
  listMyOrganizations,
  loadTenantContext,
  pickTenantId,
} from "../../lib/tenant";
import type { TenantContext } from "../../lib/tenant";
import type { LoginInput, SignupInput } from "./auth.schemas";
import { createSession } from "./session";
import type { ClientMeta } from "./session";

// What every auth function returns; auth.routes.ts hands it to sendSession().
export interface AuthResult {
  session: { accessToken: string; refreshToken: string };
  user: {
    id: bigint;
    fullName: string;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
  };
  tenant: TenantContext | null;
  organizations: unknown[];
}

// Verified against when the email is unknown, so "unknown email" and "wrong password" take the same time.
const dummyHash = argon2.hash("not-a-real-password");

// A refresh token used within this many seconds is a harmless race (second tab, React double-start): 409, no revoke.
const REFRESH_GRACE_SECONDS = 10;

// ---------------------------------------------------------------- C6
export async function signup(
  input: SignupInput,
  meta: ClientMeta,
): Promise<AuthResult> {
  const passwordHash = await argon2.hash(input.password);
  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        fullName: input.fullName,
        passwordHash,
        passwordChangedAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        avatarUrl: true,
      },
    });

    const session = await createSession({
      userId: user.id,
      tenantId: null,
      meta,
    });
    return { session, user, tenant: null, organizations: [] };
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new HttpError(409, "An account with this email already exists");
    }
    throw e;
  }
}

// ---------------------------------------------------------------- C7
export async function login(
  input: LoginInput,
  meta: ClientMeta,
): Promise<AuthResult> {
  const invalid = () => new HttpError(401, "Invalid email or password");

  // find the person by email
  const user = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
  });

  // check the password without revealing whether the email exists
  const passwordOk = user
    ? await argon2.verify(user.passwordHash, input.password)
    : false;

  if (!user) await argon2.verify(await dummyHash, input.password);

  // one generic failure for: unknow email, wrong password, disabled account
  //
  if (!user || !passwordOk || user.status !== "active") throw invalid();

  // record login
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
    },
  });

  // choose the school to start in (none yet for a new person)
  const tenantId = await pickTenantId(user.id, input.organization);
  const tenant = tenantId ? await loadTenantContext(user.id, tenantId) : null;

  // start the session
  const session = await createSession({
    userId: user.id,
    tenantId: tenant?.id ?? null,
    meta,
  });

  return {
    session, 
    user: {id: user.id, fullName: user.fullName, email: user.email, phone: user.phone, avatarUrl: user.avatarUrl},
    tenant, 
    organizations: await listMyOrganizations(user.id),
  };
}

// ---------------------------------------------------------------- C9
// cookieToken = req.cookies.rt (undefined when the cookie is missing)
export async function refresh(
  cookieToken: string | undefined,
  meta: ClientMeta,
): Promise<AuthResult> {
  if (!cookieToken) throw new HttpError(401, "Unauthorized");

  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(cookieToken) },
  });
  if (!row || row.revokedAt) throw new HttpError(401, "Unauthorized");

  if (row.usedAt) {
    const secondsAgo = (Date.now() - row.usedAt.getTime()) / 1000;
    if (secondsAgo <= REFRESH_GRACE_SECONDS) {
      // a second browser tab or a React double-start raced us: harmless, revoke nothing
      throw new HttpError(409, "Session refresh in progress");
    }
    // an OLD token was replayed much later: somebody copied it. Kill the whole login.
    await revokeFamily(row.familyId, "reuse_detected");
    throw new HttpError(401, "Unauthorized");
  }
  if (row.expiresAt < new Date()) throw new HttpError(401, "Unauthorized");

  // claim it atomically: of two simultaneous requests only ONE can flip usedAt from null
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: row.id, usedAt: null, revokedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw new HttpError(409, "Session refresh in progress");

  const user = await prisma.user.findFirst({
    where: { id: row.userId, status: "active", deletedAt: null },
    select: { id: true, email: true, fullName: true, phone: true, avatarUrl: true },
  });
  if (!user) throw new HttpError(401, "Unauthorized");

  // keep the school this session was in if the membership is still valid, otherwise fall back
  let tenant = row.tenantId ? await loadTenantContext(user.id, row.tenantId) : null;
  if (!tenant) {
    const fallbackId = await pickTenantId(user.id);
    tenant = fallbackId ? await loadTenantContext(user.id, fallbackId) : null;
  }

  const session = await createSession({
    userId: user.id,
    tenantId: tenant?.id ?? null,
    meta,
    familyId: row.familyId, // same chain, so one logout or one theft signal covers it all
  });
  return { session, user, tenant, organizations: await listMyOrganizations(user.id) };
}

export async function logout(cookieToken: string | undefined): Promise<void> {
  if (!cookieToken) return; // nothing to revoke; logging out must never fail
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(cookieToken) },
  });
  if (row) await revokeFamily(row.familyId, "logout");
}

// ---------------------------------------------------------------- C10c
export async function switchOrganization(
  userId: bigint,
  slug: string,
  cookieToken: string | undefined,
  meta: ClientMeta,
): Promise<AuthResult> {
  // The person's own active membership in the school with that slug. We query it directly (pickTenantId would
  // FALL BACK to another school). Same 403 whether the school does not exist or the person is not in it.
  const noAccess = () => new HttpError(403, "You do not have access to this organization");
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      status: "active",
      tenant: { is: { slug: slug.toLowerCase(), status: "active", deletedAt: null } },
    },
    select: { tenantId: true },
  });
  if (!membership) throw noAccess();

  const tenant = await loadTenantContext(userId, membership.tenantId);
  if (!tenant) throw noAccess();

  // Take over the current login chain if the cookie belongs to this person and is still unused.
  let familyId: string | undefined;
  if (cookieToken) {
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(cookieToken) } });
    if (row && row.userId === userId && !row.usedAt && !row.revokedAt && row.expiresAt > new Date()) {
      const claimed = await prisma.refreshToken.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 1) familyId = row.familyId;
    }
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, status: "active", deletedAt: null },
    select: { id: true, email: true, fullName: true, phone: true, avatarUrl: true },
  });
  if (!user) throw new HttpError(401, "Unauthorized");

  const session = await createSession({ userId, tenantId: tenant.id, meta, familyId });
  return { session, user, tenant, organizations: await listMyOrganizations(userId) };
}

// Revokes every refresh token of one login chain.
export function revokeFamily(familyId: string, reason: string) {
  return prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}
