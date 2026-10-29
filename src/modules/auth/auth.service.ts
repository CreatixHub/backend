import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { listMyOrganizations, loadTenantContext, pickTenantId } from '../../lib/tenant';
import type { TenantContext } from '../../lib/tenant';
import type { LoginInput, SignupInput } from './auth.schemas';
import { createSession } from './session';
import type { ClientMeta } from './session';

// What every auth function returns; auth.routes.ts hands it to sendSession().
export interface AuthResult {
  session: { accessToken: string; refreshToken: string };
  user: { id: bigint; fullName: string; email: string; phone: string | null; avatarUrl: string | null };
  tenant: TenantContext | null;
  organizations: unknown[];
}

// Verified against when the email is unknown, so "unknown email" and "wrong password" take the same time.
const dummyHash = argon2.hash('not-a-real-password');

// A refresh token used within this many seconds is a harmless race (second tab, React double-start): 409, no revoke.
const REFRESH_GRACE_SECONDS = 10;

// ---------------------------------------------------------------- C6
export async function signup(input: SignupInput, meta: ClientMeta): Promise<AuthResult> {
  // TODO 1: const passwordHash = await argon2.hash(input.password)
  // TODO 2: try { prisma.user.create({ data: { email: input.email.toLowerCase(), fullName, passwordHash,
  //                passwordChangedAt: new Date() }, select: { id, email, fullName, phone, avatarUrl } }) }
  //         catch: Prisma.PrismaClientKnownRequestError with code 'P2002' -> throw new HttpError(409, 'An account with this email already exists')
  //                anything else -> rethrow
  // TODO 3: const session = await createSession({ userId: user.id, tenantId: null, meta })
  // TODO 4: return { session, user, tenant: null, organizations: [] }   (a new person belongs to no school yet)
  void Prisma; void argon2; void prisma; void HttpError;
  throw new Error('TODO C6: signup');
}

// ---------------------------------------------------------------- C7
export async function login(input: LoginInput, meta: ClientMeta): Promise<AuthResult> {
  // const invalid = () => new HttpError(401, 'Invalid email or password')   // SAME message for every failure
  // TODO 1: find the user: prisma.user.findFirst({ where: { email: input.email.toLowerCase(), deletedAt: null } })
  // TODO 2: password check WITHOUT revealing if the email exists:
  //         ok = user ? await argon2.verify(user.passwordHash, input.password) : false
  //         if (!user) await argon2.verify(await dummyHash, input.password)   // burn the same time
  // TODO 3: if (!user || !ok || user.status !== 'active') throw invalid()
  // TODO 4: update lastLoginAt = now
  // TODO 5: const tenantId = await pickTenantId(user.id, input.organization)
  //         const tenant = tenantId ? await loadTenantContext(user.id, tenantId) : null
  // TODO 6: const session = await createSession({ userId: user.id, tenantId: tenant?.id ?? null, meta })
  // TODO 7: return { session, user: {id, fullName, email, phone, avatarUrl}, tenant, organizations: await listMyOrganizations(user.id) }
  void dummyHash; void pickTenantId; void loadTenantContext; void listMyOrganizations;
  throw new Error('TODO C7: login');
}

// ---------------------------------------------------------------- C9
// cookieToken = req.cookies.rt (undefined when the cookie is missing)
export async function refresh(cookieToken: string | undefined, meta: ClientMeta): Promise<AuthResult> {
  // TODO 1: no cookie -> throw new HttpError(401, 'Unauthorized')
  // TODO 2: row = prisma.refreshToken.findUnique({ where: { tokenHash: sha256(cookieToken) } }); none -> 401
  // TODO 3: if row.revokedAt -> 401
  // TODO 4: if row.usedAt:
  //           used within REFRESH_GRACE_SECONDS -> throw new HttpError(409, 'Session refresh in progress')   (revoke NOTHING)
  //           older -> theft signal: revokeFamily(row.familyId, 'reuse_detected'), then 401
  // TODO 5: row.expiresAt < now -> 401
  // TODO 6: claim it atomically:
  //         const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } })
  //         if (claimed.count !== 1) throw new HttpError(409, 'Session refresh in progress')
  // TODO 7: load the user (status 'active', deletedAt null) or 401
  // TODO 8: keep row.tenantId if loadTenantContext(user.id, row.tenantId) is not null, else pickTenantId(user.id)
  // TODO 9: createSession({ userId, tenantId, meta, familyId: row.familyId }) and return like login
  void sha256; void revokeFamily;
  throw new Error('TODO C9: refresh');
}

export async function logout(cookieToken: string | undefined): Promise<void> {
  // TODO: if cookieToken: find its row (by sha256) and revokeFamily(row.familyId, 'logout'). Never throw for a missing/unknown cookie.
  void cookieToken;
}

// ---------------------------------------------------------------- C10c
export async function switchOrganization(
  userId: bigint,
  slug: string,
  cookieToken: string | undefined,
  meta: ClientMeta,
): Promise<AuthResult> {
  // TODO 1: tenantId = membership of userId in the active school with that slug -> pickTenantId would FALL BACK to another school,
  //         so query it directly: prisma.membership.findFirst({ where: { userId, status: 'active',
  //         tenant: { is: { slug: slug.toLowerCase(), status: 'active', deletedAt: null } } }, select: { tenantId: true } })
  //         none -> throw new HttpError(403, 'You do not have access to this organization')   (same answer if the school does not exist)
  // TODO 2: tenant = await loadTenantContext(userId, tenantId)
  // TODO 3: familyId: if cookieToken matches an UNUSED, UNREVOKED row of THIS user, claim it (same updateMany as refresh) and reuse its familyId;
  //         otherwise leave familyId undefined (new family)
  // TODO 4: session = createSession({ userId, tenantId, meta, familyId }); load the user; return like login
  void userId; void slug; void cookieToken; void meta;
  throw new Error('TODO C10c: switchOrganization');
}

// Revokes every refresh token of one login chain.
export function revokeFamily(familyId: string, reason: string) {
  return prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}
