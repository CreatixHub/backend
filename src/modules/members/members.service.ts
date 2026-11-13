import * as argon2 from 'argon2';
import { and, asc, count, eq, inArray, ilike, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import { membershipRoles, memberships, roles, users } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isForeignKeyViolation, isUniqueViolation, pgConstraint } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { AddMemberInput, ListMembersInput, UpdateMemberInput } from './members.schemas';

// A "member" is a membership row; its id is the MEMBERSHIP id.
// RULES for every function: every query has tenantId = tenant.id (from the VERIFIED token), and roles are
// looked up INSIDE this school only.

interface MemberRow {
  id: bigint;
  userId: bigint;
  username: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  userType: string;
  userStatus: string;
  invitedAt: Date | null;
  lastLoginAt: Date | null;
  status: string;
  createdAt: Date;
  roleCodes: string[];
}

const toMember = (m: MemberRow) => ({
  id: m.id,
  userId: m.userId,
  username: m.username,
  name: m.fullName,
  email: m.email,
  phone: m.phone,
  userType: m.userType,
  userStatus: m.userStatus,
  invitedAt: m.invitedAt,
  lastLoginAt: m.lastLoginAt,
  status: m.status,
  roles: m.roleCodes,
  createdAt: m.createdAt,
});

function inferUserType(roleCodes: string[]): 'owner' | 'admin' | 'student' | 'guardian' | 'staff' {
  if (roleCodes.includes('owner')) return 'owner';
  if (roleCodes.includes('admin')) return 'admin';
  if (roleCodes.includes('student')) return 'student';
  if (roleCodes.includes('parent')) return 'guardian';
  return 'staff';
}

// Fetches a batch of membership rows (with user info and role codes) by membership id.
async function loadMembers(membershipIds: bigint[]): Promise<Map<bigint, MemberRow>> {
  if (membershipIds.length === 0) return new Map();
  const base = await db
    .select({
      id: memberships.id,
      userId: memberships.userId,
      username: users.username,
      fullName: users.fullName,
      email: users.email,
      phone: users.phone,
      userType: users.userType,
      userStatus: users.status,
      invitedAt: users.invitedAt,
      lastLoginAt: users.lastLoginAt,
      status: memberships.status,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(inArray(memberships.id, membershipIds));

  const roleRows = await db
    .select({ membershipId: membershipRoles.membershipId, code: roles.code })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(inArray(membershipRoles.membershipId, membershipIds));
  const rolesByMembership = new Map<bigint, string[]>();
  for (const r of roleRows) {
    const list = rolesByMembership.get(r.membershipId) ?? [];
    list.push(r.code);
    rolesByMembership.set(r.membershipId, list);
  }

  const result = new Map<bigint, MemberRow>();
  for (const row of base) {
    result.set(row.id, { ...row, roleCodes: rolesByMembership.get(row.id) ?? [] });
  }
  return result;
}

async function loadMember(membershipId: bigint): Promise<MemberRow | undefined> {
  return (await loadMembers([membershipId])).get(membershipId);
}

const isOwner = (tenant: TenantContext) => tenant.roles.includes('owner');

// Looks role codes up INSIDE the caller's school: you can never assign another school's role.
async function resolveRoles(tenantId: bigint, codes: string[]) {
  const unique = [...new Set(codes)];
  const found = await db
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), inArray(roles.code, unique)));
  const missing = unique.filter((c) => !found.some((r) => r.code === c));
  if (missing.length) throw new HttpError(400, `Unknown role: ${missing.join(', ')}`);
  return found;
}

export async function listMembers(
  tenant: TenantContext,
  q: ListMembersInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  const where = and(
    eq(memberships.tenantId, tenant.id),
    q.q
      ? or(ilike(users.fullName, `%${q.q}%`), ilike(users.email, `%${q.q}%`), ilike(users.username, `%${q.q}%`))
      : undefined,
  );

  const [idRows, [{ total }]] = await Promise.all([
    db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(where)
      .orderBy(asc(memberships.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db
      .select({ total: count() })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(where),
  ]);

  const membersById = await loadMembers(idRows.map((r) => r.id));
  const rows = idRows.map((r) => toMember(membersById.get(r.id)!));
  return { rows, meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
}

export async function addMember(tenant: TenantContext, _actor: AuthUser, input: AddMemberInput): Promise<unknown> {
  const roleRows = await resolveRoles(tenant.id, input.roles);
  if (roleRows.some((r) => r.code === 'owner') && !isOwner(tenant)) {
    throw new HttpError(403, 'Only an owner can make someone an owner');
  }

  try {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);

    if (existing) {
      const [already] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, existing.id)))
        .limit(1);
      if (already) throw new HttpError(409, 'This person is already a member of this school');

      const [membership] = await db
        .insert(memberships)
        .values({ tenantId: tenant.id, userId: existing.id })
        .returning({ id: memberships.id });
      await db
        .insert(membershipRoles)
        .values(roleRows.map((r) => ({ membershipId: membership.id, roleId: r.id, tenantId: tenant.id })));
      return toMember((await loadMember(membership.id))!);
    }

    // No account yet: the admin creates it (either directly with a password or as an invited account).
    const errors: { field: string; message: string }[] = [];
    if (!input.fullName) errors.push({ field: 'fullName', message: 'Required for a new account' });
    if (!input.invite && !input.password) errors.push({ field: 'password', message: 'Required for a new account' });
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);

    const passwordHash = input.password ? await argon2.hash(input.password) : null;
    const isInvited = Boolean(input.invite && !passwordHash);
    const userType = input.userType ?? inferUserType(roleRows.map((r) => r.code));
    const membershipId = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          username: input.username ?? null,
          phone: input.phone ?? null,
          fullName: input.fullName!,
          passwordHash,
          userType,
          status: isInvited ? 'invited' : 'active',
          invitedAt: input.invite ? new Date() : null,
          timezone: input.timezone ?? null,
          languageId: input.languageId ?? null,
          mustChangePassword: input.mustChangePassword ?? isInvited,
          passwordChangedAt: passwordHash ? new Date() : null,
        })
        .returning({ id: users.id });
      const [membership] = await tx
        .insert(memberships)
        .values({ tenantId: tenant.id, userId: user.id })
        .returning({ id: memberships.id });
      await tx
        .insert(membershipRoles)
        .values(roleRows.map((r) => ({ membershipId: membership.id, roleId: r.id, tenantId: tenant.id })));
      return membership.id;
    });
    return toMember((await loadMember(membershipId))!);
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (pgConstraint(e) === 'users_username_key') {
        throw new HttpError(409, 'An account with this username already exists');
      }
      throw new HttpError(409, 'This person is already a member of this school');
    }
    if (isForeignKeyViolation(e)) {
      throw new HttpError(400, 'Invalid reference ID provided');
    }
    throw e;
  }
}

// Shared guards for changing or removing someone: not yourself, owner rules, and a school keeps >= 1 active owner.
async function loadTarget(tenant: TenantContext, actor: AuthUser, membershipId: bigint) {
  const [target] = await db
    .select({ id: memberships.id, userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenant.id)))
    .limit(1);
  if (!target) throw new HttpError(404, 'Member not found');
  if (target.userId === actor.id) throw new HttpError(400, 'You cannot change your own access');

  const roleCodes = await db
    .select({ code: roles.code })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(eq(membershipRoles.membershipId, membershipId));
  const targetIsOwner = roleCodes.some((r) => r.code === 'owner');
  if (targetIsOwner && !isOwner(tenant)) throw new HttpError(403, 'Only an owner can change an owner');
  return { target, targetIsOwner };
}

async function assertKeepsAnOwner(tenantId: bigint, membershipId: bigint) {
  const [{ total }] = await db
    .select({ total: count() })
    .from(memberships)
    .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        ne(memberships.id, membershipId),
        eq(roles.code, 'owner'),
      ),
    );
  if (total < 1) throw new HttpError(400, 'A school needs at least one active owner');
}

export async function updateMember(
  tenant: TenantContext,
  actor: AuthUser,
  membershipId: bigint,
  input: UpdateMemberInput,
): Promise<unknown> {
  const { target, targetIsOwner } = await loadTarget(tenant, actor, membershipId);

  const newRoles = input.roles ? await resolveRoles(tenant.id, input.roles) : undefined;
  const grantsOwner = newRoles?.some((r) => r.code === 'owner') ?? false;
  if (grantsOwner && !isOwner(tenant)) throw new HttpError(403, 'Only an owner can make someone an owner');

  const willBeOwner = newRoles ? grantsOwner : targetIsOwner;
  const willBeActive = (input.status ?? target.status) === 'active';
  if (targetIsOwner && !(willBeOwner && willBeActive)) await assertKeepsAnOwner(tenant.id, membershipId);

  await db.transaction(async (tx) => {
    if (input.status) await tx.update(memberships).set({ status: input.status }).where(eq(memberships.id, membershipId));
    if (newRoles) {
      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membershipId));
      await tx
        .insert(membershipRoles)
        .values(newRoles.map((r) => ({ membershipId, roleId: r.id, tenantId: tenant.id })));
    }
  });

  return toMember((await loadMember(membershipId))!);
}

export async function removeMember(tenant: TenantContext, actor: AuthUser, membershipId: bigint): Promise<void> {
  const { targetIsOwner } = await loadTarget(tenant, actor, membershipId);
  if (targetIsOwner) await assertKeepsAnOwner(tenant.id, membershipId);
  // the person's account stays (they may belong to other schools); only this membership goes, its role links cascade
  await db.delete(memberships).where(eq(memberships.id, membershipId));
}
