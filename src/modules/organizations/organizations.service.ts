import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { memberships, membershipRoles, organizations, permissions, rolePermissions, roles } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { DEFAULT_ROLES } from '../../permissions';
import type { CreateOrganizationInput, UpdateOrganizationInput } from './organizations.schemas';

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

// CREATE A SCHOOL. The signed-in person becomes its owner. ONE transaction: if any step fails, nothing is saved.
export async function createOrganization(input: CreateOrganizationInput, user: AuthUser, _ip?: string): Promise<unknown> {
  try {
    const org = await db.transaction(async (tx) => {
      // 1. the school itself
      const [org] = await tx
        .insert(organizations)
        .values({ slug: input.slug, name: input.name, timezone: input.timezone ?? 'UTC' })
        .returning();

      // 2. its own copy of every default role, each with its permissions
      const permissionRows = await tx.select({ id: permissions.id, code: permissions.code }).from(permissions);
      const permissionId = new Map(permissionRows.map((p) => [p.code, p.id]));
      let ownerRoleId: bigint | undefined;

      for (const def of DEFAULT_ROLES) {
        const [role] = await tx
          .insert(roles)
          .values({ tenantId: org.id, code: def.code, name: def.name, description: def.description, isSystem: true })
          .returning({ id: roles.id });
        if (def.code === 'owner') ownerRoleId = role.id;
        // owner has zero rows here by design (it's a wildcard, checked in code, never enumerated) -
        // drizzle's .values([]) throws instead of no-op'ing like Prisma's createMany did, so guard it.
        if (def.permissions.length > 0) {
          await tx.insert(rolePermissions).values(
            def.permissions.map((code) => {
              const id = permissionId.get(code);
              if (!id) throw new Error(`Permission "${code}" is not in the database - run: npx tsx src/seed.ts`);
              return { roleId: role.id, permissionId: id, tenantId: org.id };
            }),
          );
        }
      }
      if (!ownerRoleId) throw new Error('DEFAULT_ROLES must contain an "owner" role');

      // 3. the creator joins the school as its owner
      const [membership] = await tx
        .insert(memberships)
        .values({ tenantId: org.id, userId: user.id })
        .returning({ id: memberships.id });
      await tx.insert(membershipRoles).values({ membershipId: membership.id, roleId: ownerRoleId, tenantId: org.id });

      return org;
    });

    return { id: org.id, slug: org.slug, name: org.name, timezone: org.timezone, roles: ['owner'] };
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new HttpError(409, 'An organization with this slug already exists');
    }
    throw e;
  }
}

// "The school I am acting in right now."
export async function currentOrganization(tenant: TenantContext): Promise<unknown> {
  const [org] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      timezone: organizations.timezone,
      status: organizations.status,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, tenant.id))
    .limit(1);
  if (!org) throw new HttpError(404, 'Organization not found');
  return { ...org, myRoles: tenant.roles, myPermissions: [...tenant.permissions].sort() };
}

export async function updateCurrentOrganization(tenant: TenantContext, input: UpdateOrganizationInput): Promise<unknown> {
  // drizzle's .set() skips undefined keys like Prisma did, but throws if EVERY key ends up undefined -
  // an empty PATCH body is valid here (no @@refine on the schema), so guard that case ourselves.
  const changes: { name?: string; timezone?: string } = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.timezone !== undefined) changes.timezone = input.timezone;

  if (Object.keys(changes).length > 0) {
    // filtering by id comes from the VERIFIED tenant, never from the request.
    const updated = await db
      .update(organizations)
      .set(changes)
      .where(and(eq(organizations.id, tenant.id), isNull(organizations.deletedAt)))
      .returning({ id: organizations.id });
    if (!updated.length) throw new HttpError(404, 'Organization not found');
  }
  return currentOrganization(tenant);
}
