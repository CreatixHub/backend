import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { AddMemberInput, ListMembersInput, UpdateMemberInput } from './members.schemas';

// A "member" is a membership row; its id is the MEMBERSHIP id.
// RULES for every function: every query has tenantId = tenant.id (from the VERIFIED token), and roles are
// looked up INSIDE this school only.

const MEMBER_SELECT = {
  id: true,
  userId: true,
  status: true,
  createdAt: true,
  user: { select: { fullName: true, email: true, phone: true } },
  roles: { select: { role: { select: { code: true } } } },
} satisfies Prisma.MembershipSelect;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof MEMBER_SELECT }>;

const toMember = (m: MemberRow) => ({
  id: m.id,
  userId: m.userId,
  name: m.user.fullName,
  email: m.user.email,
  phone: m.user.phone,
  status: m.status,
  roles: m.roles.map((r) => r.role.code),
  createdAt: m.createdAt,
});

const isOwner = (tenant: TenantContext) => tenant.roles.includes('owner');

// Looks role codes up INSIDE the caller's school: you can never assign another school's role.
async function resolveRoles(tenantId: bigint, codes: string[]) {
  const unique = [...new Set(codes)];
  const roles = await prisma.role.findMany({ where: { tenantId, code: { in: unique } }, select: { id: true, code: true } });
  const missing = unique.filter((c) => !roles.some((r) => r.code === c));
  if (missing.length) throw new HttpError(400, `Unknown role: ${missing.join(', ')}`);
  return roles;
}

export async function listMembers(
  tenant: TenantContext,
  q: ListMembersInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  const where: Prisma.MembershipWhereInput = {
    tenantId: tenant.id,
    ...(q.q
      ? {
          user: {
            is: {
              OR: [
                { fullName: { contains: q.q, mode: 'insensitive' } },
                { email: { contains: q.q, mode: 'insensitive' } },
              ],
            },
          },
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.membership.findMany({
      where,
      select: MEMBER_SELECT,
      orderBy: { id: 'asc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.membership.count({ where }),
  ]);
  return { rows: rows.map(toMember), meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
}

export async function addMember(tenant: TenantContext, _actor: AuthUser, input: AddMemberInput): Promise<unknown> {
  const roles = await resolveRoles(tenant.id, input.roles);
  if (roles.some((r) => r.code === 'owner') && !isOwner(tenant)) {
    throw new HttpError(403, 'Only an owner can make someone an owner');
  }
  const roleLinks = roles.map((r) => ({ roleId: r.id, tenantId: tenant.id }));

  try {
    const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });

    if (existing) {
      const already = await prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenant.id, userId: existing.id } },
        select: { id: true },
      });
      if (already) throw new HttpError(409, 'This person is already a member of this school');
      const created = await prisma.membership.create({
        data: { tenantId: tenant.id, userId: existing.id, roles: { create: roleLinks } },
        select: MEMBER_SELECT,
      });
      return toMember(created);
    }

    // No account yet: the admin creates it, so name and a temporary password are required.
    const errors: { field: string; message: string }[] = [];
    if (!input.fullName) errors.push({ field: 'fullName', message: 'Required for a new account' });
    if (!input.password) errors.push({ field: 'password', message: 'Required for a new account' });
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);

    const passwordHash = await argon2.hash(input.password!);
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.email, fullName: input.fullName!, passwordHash, passwordChangedAt: new Date() },
        select: { id: true },
      });
      return tx.membership.create({
        data: { tenantId: tenant.id, userId: user.id, roles: { create: roleLinks } },
        select: MEMBER_SELECT,
      });
    });
    return toMember(created);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HttpError(409, 'This person is already a member of this school');
    }
    throw e;
  }
}

// Shared guards for changing or removing someone: not yourself, owner rules, and a school keeps >= 1 active owner.
async function loadTarget(tenant: TenantContext, actor: AuthUser, membershipId: bigint) {
  const target = await prisma.membership.findFirst({
    where: { id: membershipId, tenantId: tenant.id },
    select: { userId: true, status: true, roles: { select: { role: { select: { code: true } } } } },
  });
  if (!target) throw new HttpError(404, 'Member not found');
  if (target.userId === actor.id) throw new HttpError(400, 'You cannot change your own access');
  const targetIsOwner = target.roles.some((r) => r.role.code === 'owner');
  if (targetIsOwner && !isOwner(tenant)) throw new HttpError(403, 'Only an owner can change an owner');
  return { target, targetIsOwner };
}

async function assertKeepsAnOwner(tenantId: bigint, membershipId: bigint) {
  const others = await prisma.membership.count({
    where: { tenantId, status: 'active', id: { not: membershipId }, roles: { some: { role: { code: 'owner' } } } },
  });
  if (others < 1) throw new HttpError(400, 'A school needs at least one active owner');
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

  await prisma.$transaction(async (tx) => {
    if (input.status) await tx.membership.update({ where: { id: membershipId }, data: { status: input.status } });
    if (newRoles) {
      await tx.membershipRole.deleteMany({ where: { membershipId } });
      await tx.membershipRole.createMany({
        data: newRoles.map((r) => ({ membershipId, roleId: r.id, tenantId: tenant.id })),
      });
    }
  });

  const updated = await prisma.membership.findFirstOrThrow({
    where: { id: membershipId, tenantId: tenant.id },
    select: MEMBER_SELECT,
  });
  return toMember(updated);
}

export async function removeMember(tenant: TenantContext, actor: AuthUser, membershipId: bigint): Promise<void> {
  const { targetIsOwner } = await loadTarget(tenant, actor, membershipId);
  if (targetIsOwner) await assertKeepsAnOwner(tenant.id, membershipId);
  // the person's account stays (they may belong to other schools); only this membership goes, its role links cascade
  await prisma.membership.delete({ where: { id: membershipId } });
}
