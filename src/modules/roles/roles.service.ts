import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { membershipRoles, permissions, rolePermissions, roles } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schemas';

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

interface RoleRow {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  memberCount: number;
  permissionCodes: string[];
}

const toRole = (r: RoleRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  isSystem: r.isSystem,
  memberCount: r.memberCount,
  permissions: r.code === 'owner' ? ['*'] : [...r.permissionCodes].sort(),
});

// Loads a batch of roles (with their permission codes and member counts) by role id.
async function loadRoles(roleIds: bigint[]): Promise<Map<bigint, RoleRow>> {
  if (roleIds.length === 0) return new Map();
  const base = await db
    .select({ id: roles.id, code: roles.code, name: roles.name, description: roles.description, isSystem: roles.isSystem })
    .from(roles)
    .where(inArray(roles.id, roleIds));

  const permRows = await db
    .select({ roleId: rolePermissions.roleId, code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(inArray(rolePermissions.roleId, roleIds));
  const permsByRole = new Map<bigint, string[]>();
  for (const p of permRows) {
    const list = permsByRole.get(p.roleId) ?? [];
    list.push(p.code);
    permsByRole.set(p.roleId, list);
  }

  const countRows = await db
    .select({ roleId: membershipRoles.roleId, total: count() })
    .from(membershipRoles)
    .where(inArray(membershipRoles.roleId, roleIds))
    .groupBy(membershipRoles.roleId);
  const countByRole = new Map(countRows.map((r) => [r.roleId, r.total]));

  const result = new Map<bigint, RoleRow>();
  for (const r of base) {
    result.set(r.id, {
      ...r,
      memberCount: countByRole.get(r.id) ?? 0,
      permissionCodes: permsByRole.get(r.id) ?? [],
    });
  }
  return result;
}

async function loadOneRole(roleId: bigint): Promise<RoleRow | undefined> {
  return (await loadRoles([roleId])).get(roleId);
}

// The whole catalogue, flat and sorted.
export async function listPermissions(): Promise<unknown> {
  return db
    .select({ code: permissions.code, module: permissions.module, action: permissions.action })
    .from(permissions)
    .orderBy(asc(permissions.module), asc(permissions.action));
}

// This school's roles with their permissions and how many people hold each.
export async function listRoles(tenant: TenantContext): Promise<unknown> {
  const ids = await db.select({ id: roles.id }).from(roles).where(eq(roles.tenantId, tenant.id)).orderBy(asc(roles.id));
  const byId = await loadRoles(ids.map((r) => r.id));
  return ids.map((r) => toRole(byId.get(r.id)!));
}

async function permissionIds(codes: string[]) {
  const unique = [...new Set(codes)];
  const found = await db.select({ id: permissions.id, code: permissions.code }).from(permissions).where(inArray(permissions.code, unique));
  const missing = unique.filter((c) => !found.some((p) => p.code === c));
  if (missing.length) throw new HttpError(400, `Unknown permission: ${missing.join(', ')}`);
  return found;
}

async function loadRole(tenant: TenantContext, roleId: bigint) {
  const [exists] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenant.id)))
    .limit(1);
  if (!exists) throw new HttpError(404, 'Role not found');
  return (await loadOneRole(roleId))!;
}

export async function createRole(tenant: TenantContext, input: CreateRoleInput): Promise<unknown> {
  const perms = await permissionIds(input.permissions);
  try {
    const roleId = await db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ tenantId: tenant.id, code: input.code, name: input.name, description: input.description, isSystem: false })
        .returning({ id: roles.id });
      if (perms.length) {
        await tx.insert(rolePermissions).values(perms.map((p) => ({ roleId: role.id, permissionId: p.id, tenantId: tenant.id })));
      }
      return role.id;
    });
    return toRole(await loadRole(tenant, roleId));
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new HttpError(409, 'A role with this code already exists');
    }
    throw e;
  }
}

export async function updateRole(tenant: TenantContext, roleId: bigint, input: UpdateRoleInput): Promise<unknown> {
  const role = await loadRole(tenant, roleId);
  if (role.isSystem) throw new HttpError(403, 'System roles cannot be changed');
  const perms = input.permissions ? await permissionIds(input.permissions) : undefined;

  // drizzle's .set() throws if every field ends up undefined (unlike Prisma, which just no-ops) -
  // this schema has no "at least one field" refine, so a {permissions: [...]}-only body is valid.
  const changes: { name?: string; description?: string } = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description;

  await db.transaction(async (tx) => {
    if (Object.keys(changes).length > 0) await tx.update(roles).set(changes).where(eq(roles.id, roleId));
    if (perms) {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (perms.length) {
        await tx.insert(rolePermissions).values(perms.map((p) => ({ roleId, permissionId: p.id, tenantId: tenant.id })));
      }
    }
  });
  return toRole(await loadRole(tenant, roleId));
}

export async function deleteRole(tenant: TenantContext, roleId: bigint): Promise<void> {
  const role = await loadRole(tenant, roleId);
  if (role.isSystem) throw new HttpError(403, 'System roles cannot be deleted');
  if (role.memberCount > 0) throw new HttpError(409, 'Role is in use');
  await db.delete(roles).where(eq(roles.id, roleId));
}
