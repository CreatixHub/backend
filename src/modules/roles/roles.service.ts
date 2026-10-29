import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schemas';

// MUST: listPermissions and listRoles.  SHOULD: createRole, updateRole, deleteRole.

// The whole catalogue, flat and sorted: [{ code, module, action }]
export async function listPermissions(): Promise<unknown> {
  // TODO: prisma.permission.findMany({ select: { code: true, module: true, action: true }, orderBy: [{ module: 'asc' }, { action: 'asc' }] })
  void prisma;
  throw new Error('TODO C11a: listPermissions');
}

// This school's roles: [{ id, code, name, description, isSystem, memberCount, permissions: ['students.view', ...] }]
// The owner role shows permissions ['*'].
export async function listRoles(tenant: TenantContext): Promise<unknown> {
  // TODO: prisma.role.findMany({ where: { tenantId: tenant.id }, orderBy: { id: 'asc' },
  //         select: { id, code, name, description, isSystem, _count: { select: { membershipRoles: true } },
  //                   rolePermissions: { select: { permission: { select: { code: true } } } } } })
  // TODO: map: memberCount = _count.membershipRoles; permissions = code === 'owner' ? ['*'] : sorted codes
  void tenant;
  throw new Error('TODO C11a: listRoles');
}

export async function createRole(tenant: TenantContext, input: CreateRoleInput): Promise<unknown> {
  // TODO: every permission code must exist (else 400 listing the unknown ones); duplicate code in this school -> 409 (P2002);
  //       create a CUSTOM role (isSystem: false) and its role_permissions in ONE transaction
  void tenant; void input; void HttpError;
  throw new Error('TODO C11c: createRole');
}

export async function updateRole(tenant: TenantContext, roleId: bigint, input: UpdateRoleInput): Promise<unknown> {
  // TODO: find the role with { id: roleId, tenantId: tenant.id } (404); isSystem -> HttpError(403, 'System roles cannot be changed');
  //       update name/description; if permissions given REPLACE the set (deleteMany + createMany) in ONE transaction
  void tenant; void roleId; void input;
  throw new Error('TODO C11c: updateRole');
}

export async function deleteRole(tenant: TenantContext, roleId: bigint): Promise<void> {
  // TODO: 404 if not in this school; system -> 403; any membership uses it -> HttpError(409, 'Role is in use'); else delete
  void tenant; void roleId;
  throw new Error('TODO C11c: deleteRole');
}
