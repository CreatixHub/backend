import * as argon2 from "argon2";
import { isIP } from "node:net";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { memberships, organizations, refreshTokens, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { sha256 } from "../../lib/hash";
import { isForeignKeyViolation, isUniqueViolation, pgConstraint } from "../../lib/pgErrors";
import {
  listMyOrganizations,
  loadTenantContext,
  pickTenantId,
} from "../../lib/tenant";
import type { TenantContext } from "../../lib/tenant";
import type { AuthUser } from "../../middleware/authenticate";
import type { LoginInput, SignupInput } from "./auth.schemas";
import { createSession } from "./session";
import type { ClientMeta } from "./session";

// What every auth function returns; auth.routes.ts hands it to sendSession().
export interface AuthResult {
  session: { accessToken: string; refreshToken: string };
  user: AuthUser;
  tenant: TenantContext | null;
  organizations: unknown[];
}

const PUBLIC_USER_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  fullName: users.fullName,
  phone: users.phone,
  avatarUrl: users.avatarUrl,
  avatarFileId: users.avatarFileId,
  languageId: users.languageId,
  timezone: users.timezone,
  preferences: users.preferences,
  userType: users.userType,
  status: users.status,
  mustChangePassword: users.mustChangePassword,
  mfaEnabled: users.mfaEnabled,
};

function normalizeIp(raw?: string): string | null {
  if (!raw) return null;
  const candidate = raw.split(",")[0]?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

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
    const [user] = await db
      .insert(users)
      .values({
        email: input.email,
        username: input.username ?? null,
        phone: input.phone ?? null,
        fullName: input.fullName,
        passwordHash,
        userType: input.userType ?? "owner",
        status: "active",
        timezone: input.timezone ?? null,
        languageId: input.languageId ?? null,
        avatarFileId: input.avatarFileId ?? null,
        preferences: input.preferences ?? {},
        passwordChangedAt: new Date(),
      })
      .returning(PUBLIC_USER_COLUMNS);

    const session = await createSession({
      userId: user.id,
      tenantId: null,
      meta,
    });
    return { session, user, tenant: null, organizations: [] };
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (pgConstraint(e) === "users_username_key") {
        throw new HttpError(409, "An account with this username already exists");
      }
      throw new HttpError(409, "An account with this email already exists");
    }
    if (isForeignKeyViolation(e)) {
      throw new HttpError(400, "Invalid reference ID provided");
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

  // find the person by email or username
  const identifierCond = input.email ? eq(users.email, input.email) : eq(users.username, input.username!);
  const [user] = await db
    .select()
    .from(users)
    .where(and(identifierCond, isNull(users.deletedAt)))
    .limit(1);

  const isLocked = Boolean(user?.lockedUntil && user.lockedUntil > new Date());
  const canVerify = Boolean(user && user.passwordHash && !isLocked);

  // check the password without revealing whether the email exists or is locked
  const passwordOk = canVerify
    ? await argon2.verify(user!.passwordHash!, input.password)
    : false;

  if (!canVerify) await argon2.verify(await dummyHash, input.password);

  if (user && !isLocked && user.passwordHash && !passwordOk && user.status === "active") {
    const nextCount = Math.min(user.failedLoginCount + 1, 32767);
    await db
      .update(users)
      .set({
        failedLoginCount: nextCount,
        ...(nextCount >= MAX_FAILED_LOGIN_ATTEMPTS
          ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
          : {}),
      })
      .where(eq(users.id, user.id));
  }

  // one generic failure for: unknown email, wrong password, disabled/invited/locked account
  if (!user || isLocked || !passwordOk || user.status !== "active") throw invalid();

  // record login
  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      lastLoginIp: normalizeIp(meta.ip),
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, user.id));

  // choose the school to start in (none yet for a new person)
  const tenantId = await pickTenantId(user.id, input.organization);
  const tenant = tenantId ? await loadTenantContext(user.id, tenantId) : null;

  // start the session
  const session = await createSession({
    userId: user.id,
    tenantId: tenant?.id ?? null,
    meta,
  });

  const publicUser: AuthUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    avatarFileId: user.avatarFileId,
    languageId: user.languageId,
    timezone: user.timezone,
    preferences: user.preferences,
    userType: user.userType,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };

  return {
    session,
    user: publicUser,
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

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(cookieToken)))
    .limit(1);
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
  const claimed = await db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  if (claimed.length !== 1) throw new HttpError(409, "Session refresh in progress");

  const [user] = await db
    .select(PUBLIC_USER_COLUMNS)
    .from(users)
    .where(and(eq(users.id, row.userId), eq(users.status, "active"), isNull(users.deletedAt)))
    .limit(1);
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
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(cookieToken)))
    .limit(1);
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
  const [membership] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.tenantId, organizations.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        eq(organizations.slug, slug.toLowerCase()),
        eq(organizations.status, "active"),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);
  if (!membership) throw noAccess();

  const tenant = await loadTenantContext(userId, membership.tenantId);
  if (!tenant) throw noAccess();

  // Take over the current login chain if the cookie belongs to this person and is still unused.
  let familyId: string | undefined;
  if (cookieToken) {
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, sha256(cookieToken)))
      .limit(1);
    if (row && row.userId === userId && !row.usedAt && !row.revokedAt && row.expiresAt > new Date()) {
      const claimed = await db
        .update(refreshTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (claimed.length === 1) familyId = row.familyId;
    }
  }

  const [user] = await db
    .select(PUBLIC_USER_COLUMNS)
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active"), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw new HttpError(401, "Unauthorized");

  const session = await createSession({ userId, tenantId: tenant.id, meta, familyId });
  return { session, user, tenant, organizations: await listMyOrganizations(userId) };
}

// Revokes every refresh token of one login chain.
export function revokeFamily(familyId: string, reason: string) {
  return db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}
