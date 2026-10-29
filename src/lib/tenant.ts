import { prisma } from "../db";

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
const ACTIVE_SCHOOL = { is: { status: "active", deletedAt: null } };

// The caller's active membership in ONE school, with their roles and permissions there.
// Returns null when they are not an active member (or the school is suspended).
export async function loadTenantContext(userId: bigint, tenantId: bigint): Promise<TenantContext | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId, tenantId, status: "active", tenant: ACTIVE_SCHOOL },
    select: {
      tenant: { select: { id: true, slug: true, name: true } },
      roles: {
        select: {
          role: {
            select: {
              code: true,
              rolePermissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });
  if (!membership) return null;

  const roles = membership.roles.map((r) => r.role.code);
  const permissions = new Set(
    membership.roles.flatMap((r) => r.role.rolePermissions.map((rp) => rp.permission.code)),
  );
  if (roles.includes("owner")) permissions.add("*"); // owners can do everything, including future permissions

  return { ...membership.tenant, roles, permissions };
}

// Every school this person belongs to, with THEIR roles in each one.
export async function listMyOrganizations(userId: bigint) {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "active", tenant: ACTIVE_SCHOOL },
    select: {
      tenant: { select: { id: true, slug: true, name: true } },
      roles: { select: { role: { select: { code: true } } } },
    },
    orderBy: { id: "asc" },
  });
  return memberships.map((m) => ({ ...m.tenant, roles: m.roles.map((r) => r.role.code) }));
}

// The school to act in: the one named by preferredSlug if the person is an active member of it,
// otherwise their first active membership, otherwise null (no school yet).
export async function pickTenantId(userId: bigint, preferredSlug?: string): Promise<bigint | null> {
  if (preferredSlug) {
    const preferred = await prisma.membership.findFirst({
      where: {
        userId,
        status: "active",
        tenant: { is: { status: "active", deletedAt: null, slug: preferredSlug.toLowerCase() } },
      },
      select: { tenantId: true },
    });
    if (preferred) return preferred.tenantId;
  }
  const first = await prisma.membership.findFirst({
    where: { userId, status: "active", tenant: ACTIVE_SCHOOL },
    orderBy: { id: "asc" },
    select: { tenantId: true },
  });
  return first?.tenantId ?? null;
}
