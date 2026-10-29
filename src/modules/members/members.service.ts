import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { AddMemberInput, ListMembersInput, UpdateMemberInput } from './members.schemas';

// A "member" is a membership row; its id is the MEMBERSHIP id.
// Member JSON: { id, userId, name, email, phone, status, roles: ['teacher'], createdAt }
//
// RULES for every function: every query has tenantId = tenant.id (from the VERIFIED token), and roles are looked up
// INSIDE this school only. "Caller is an owner" = tenant.roles.includes('owner').

export async function listMembers(
  tenant: TenantContext,
  q: ListMembersInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  // TODO: where = { tenantId: tenant.id, user: { is: { OR: [ {fullName contains q.q, mode 'insensitive'}, {email contains ...} ] } } } (only when q.q is given)
  // TODO: const [rows, total] = await prisma.$transaction([ prisma.membership.findMany({ where, orderBy: { id: 'asc' },
  //         skip: (page - 1) * limit, take: limit, select: { id, userId, status, createdAt, user: {fullName,email,phone}, roles: {role: {code}} } }),
  //         prisma.membership.count({ where }) ])
  // TODO: map rows to the member JSON; meta = { page, limit, total, pages: Math.ceil(total / limit) }
  void tenant; void q; void prisma;
  throw new Error('TODO C11: listMembers');
}

export async function addMember(tenant: TenantContext, actor: AuthUser, input: AddMemberInput): Promise<unknown> {
  // TODO 1: look the role codes up INSIDE this school: prisma.role.findMany({ where: { tenantId: tenant.id, code: { in: codes } } })
  //         any missing -> HttpError(400, 'Unknown role: x')
  // TODO 2: assigning 'owner' requires the caller to be an owner -> else HttpError(403, ...)
  // TODO 3: existing = prisma.user.findUnique({ where: { email } }) (lower-case)
  //         exists   -> already a member of THIS school? -> HttpError(409, 'Already a member'); else create the membership + role links
  //         missing  -> fullName and password are REQUIRED (else HttpError(400, ..., [{ field, message }])); hash with argon2;
  //                     create user + membership + role links together in ONE $transaction
  // TODO 4: return the member JSON
  void Prisma; void argon2; void HttpError; void tenant; void actor; void input;
  throw new Error('TODO C11: addMember');
}

export async function updateMember(
  tenant: TenantContext,
  actor: AuthUser,
  membershipId: bigint,
  input: UpdateMemberInput,
): Promise<unknown> {
  // TODO 1: target = prisma.membership.findFirst({ where: { id: membershipId, tenantId: tenant.id }, select: { userId, status, roles... } })  none -> 404
  // TODO 2: target.userId === actor.id -> HttpError(400, 'You cannot change your own access')
  // TODO 3: touching an owner (target has 'owner', or input.roles includes 'owner') requires the caller to be an owner -> else 403
  // TODO 4: after the change the school must still have >= 1 ACTIVE owner membership -> else HttpError(400, 'A school needs at least one active owner')
  // TODO 5: apply in ONE $transaction: status update; roles replaced = membershipRole.deleteMany + createMany
  // TODO 6: return the updated member JSON
  void tenant; void actor; void membershipId; void input;
  throw new Error('TODO C11: updateMember');
}

export async function removeMember(tenant: TenantContext, actor: AuthUser, membershipId: bigint): Promise<void> {
  // TODO: same guards as updateMember (own membership, owner rules, last active owner); then prisma.membership.delete (role links cascade)
  void tenant; void actor; void membershipId;
  throw new Error('TODO C11: removeMember');
}
