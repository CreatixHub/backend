import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { membershipRoles, memberships, organizations, permissions, rolePermissions, roles } from "../db/schema";

// Which school a person is acting in right now, and what they may do THERE.
export interface TenantContext {
  id: bigint; // use this in every query: where: { tenantId: tenant.id }
  slug: string;
  name: string;
  roles: string[]; // the caller's role codes in THIS school, e.g. ["owner"]
  permissions: Set<string>; // permission codes those roles grant, e.g. "students.create"; "*" = everything (owner)
}

export function hasPermission(tenant: TenantContext, code: string): boolean {
  return tenant.permissions.has("*") || tenant.permissions.has(code);
}

// The school must be active and not deleted. Shared by every query below.
const activeTenant = () => and(eq(organizations.status, "active"), isNull(organizations.deletedAt));

// Every role (+ the permissions it grants) a set of memberships hold, grouped by membership id.
async function loadRolesByMembership(membershipIds: bigint[]): Promise<Map<bigint, string[]>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await db
    .select({ membershipId: membershipRoles.membershipId, code: roles.code })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(inArray(membershipRoles.membershipId, membershipIds));
  const byMembership = new Map<bigint, string[]>();
  for (const r of rows) {
    const list = byMembership.get(r.membershipId) ?? [];
    list.push(r.code);
    byMembership.set(r.membershipId, list);
  }
  return byMembership;
}

// The caller's active membership in ONE school, with their roles and permissions there.
// Returns null when they are not an active member (or the school is suspended).
export async function loadTenantContext(userId: bigint, tenantId: bigint): Promise<TenantContext | null> {
  const [row] = await db
    .select({
      membershipId: memberships.id,
      tenantId: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.tenantId, organizations.id))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        activeTenant(),
      ),
    )
    .limit(1);
  if (!row) return null;

  // role code + the permission code each one grants, in a single join (one row per role-permission pair)
  const grantRows = await db
    .select({ roleCode: roles.code, permissionCode: permissions.code })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(membershipRoles.membershipId, row.membershipId));

  const roleCodes = [...new Set(grantRows.map((r) => r.roleCode))];
  const grantedPermissions = new Set(grantRows.map((r) => r.permissionCode).filter((c): c is string => c !== null));
  if (roleCodes.includes("owner")) grantedPermissions.add("*"); // owners can do everything, including future permissions

  return { id: row.tenantId, slug: row.slug, name: row.name, roles: roleCodes, permissions: grantedPermissions };
}

// Every school this person belongs to, with THEIR roles in each one.
export async function listMyOrganizations(userId: bigint) {
  const rows = await db
    .select({
      membershipId: memberships.id,
      tenantId: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.tenantId, organizations.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), activeTenant()))
    .orderBy(asc(memberships.id));

  const rolesByMembership = await loadRolesByMembership(rows.map((r) => r.membershipId));
  return rows.map((r) => ({
    id: r.tenantId,
    slug: r.slug,
    name: r.name,
    roles: rolesByMembership.get(r.membershipId) ?? [],
  }));
}

// The school to act in: the one named by preferredSlug if the person is an active member of it,
// otherwise their first active membership, otherwise null (no school yet).
export async function pickTenantId(userId: bigint, preferredSlug?: string): Promise<bigint | null> {
  if (preferredSlug) {
    const [preferred] = await db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.tenantId, organizations.id))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, "active"),
          activeTenant(),
          eq(organizations.slug, preferredSlug.toLowerCase()),
        ),
      )
      .limit(1);
    if (preferred) return preferred.tenantId;
  }
  const [first] = await db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.tenantId, organizations.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), activeTenant()))
    .orderBy(asc(memberships.id))
    .limit(1);
  return first?.tenantId ?? null;
}
