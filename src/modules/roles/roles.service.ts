import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schemas';

const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isSystem: true,
  _count: { select: { membershipRoles: true } },
  rolePermissions: { select: { permission: { select: { code: true } } } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof ROLE_SELECT }>;

const toRole = (r: RoleRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  isSystem: r.isSystem,
  memberCount: r._count.membershipRoles,
  permissions: r.code === 'owner' ? ['*'] : r.rolePermissions.map((rp) => rp.permission.code).sort(),
});

// The whole catalogue, flat and sorted.
export async function listPermissions(): Promise<unknown> {
  return prisma.permission.findMany({
    select: { code: true, module: true, action: true },
    orderBy: [{ module: 'asc' }, { action: 'asc' }],
  });
}

// This school's roles with their permissions and how many people hold each.
export async function listRoles(tenant: TenantContext): Promise<unknown> {
  const roles = await prisma.role.findMany({ where: { tenantId: tenant.id }, select: ROLE_SELECT, orderBy: { id: 'asc' } });
  return roles.map(toRole);
}

async function permissionIds(codes: string[]) {
  const unique = [...new Set(codes)];
  const found = await prisma.permission.findMany({ where: { code: { in: unique } }, select: { id: true, code: true } });
  const missing = unique.filter((c) => !found.some((p) => p.code === c));
  if (missing.length) throw new HttpError(400, `Unknown permission: ${missing.join(', ')}`);
  return found;
}

async function loadRole(tenant: TenantContext, roleId: bigint) {
  const role = await prisma.role.findFirst({ where: { id: roleId, tenantId: tenant.id }, select: ROLE_SELECT });
  if (!role) throw new HttpError(404, 'Role not found');
  return role;
}

export async function createRole(tenant: TenantContext, input: CreateRoleInput): Promise<unknown> {
  const perms = await permissionIds(input.permissions);
  try {
    const roleId = await prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: { tenantId: tenant.id, code: input.code, name: input.name, description: input.description, isSystem: false },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ roleId: role.id, permissionId: p.id, tenantId: tenant.id })),
      });
      return role.id;
    });
    return toRole(await loadRole(tenant, roleId));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HttpError(409, 'A role with this code already exists');
    }
    throw e;
  }
}

export async function updateRole(tenant: TenantContext, roleId: bigint, input: UpdateRoleInput): Promise<unknown> {
  const role = await loadRole(tenant, roleId);
  if (role.isSystem) throw new HttpError(403, 'System roles cannot be changed');
  const perms = input.permissions ? await permissionIds(input.permissions) : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.role.update({ where: { id: roleId }, data: { name: input.name, description: input.description } });
    if (perms) {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: perms.map((p) => ({ roleId, permissionId: p.id, tenantId: tenant.id })),
      });
    }
  });
  return toRole(await loadRole(tenant, roleId));
}

export async function deleteRole(tenant: TenantContext, roleId: bigint): Promise<void> {
  const role = await loadRole(tenant, roleId);
  if (role.isSystem) throw new HttpError(403, 'System roles cannot be deleted');
  if (role._count.membershipRoles > 0) throw new HttpError(409, 'Role is in use');
  await prisma.role.delete({ where: { id: roleId } });
}
