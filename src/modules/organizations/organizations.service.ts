import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { DEFAULT_ROLES } from '../../permissions';
import type { CreateOrganizationInput, UpdateOrganizationInput } from './organizations.schemas';

// CREATE A SCHOOL. The signed-in person becomes its owner. ONE transaction: if any step fails, nothing is saved.
export async function createOrganization(input: CreateOrganizationInput, user: AuthUser, _ip?: string): Promise<unknown> {
  try {
    const org = await prisma.$transaction(async (tx) => {
      // 1. the school itself
      const org = await tx.organization.create({
        data: { slug: input.slug, name: input.name, timezone: input.timezone ?? 'UTC' },
      });

      // 2. its own copy of every default role, each with its permissions
      const permissions = await tx.permission.findMany({ select: { id: true, code: true } });
      const permissionId = new Map(permissions.map((p) => [p.code, p.id]));
      let ownerRoleId: bigint | undefined;

      for (const def of DEFAULT_ROLES) {
        const role = await tx.role.create({
          data: { tenantId: org.id, code: def.code, name: def.name, description: def.description, isSystem: true },
        });
        if (def.code === 'owner') ownerRoleId = role.id;
        await tx.rolePermission.createMany({
          data: def.permissions.map((code) => {
            const id = permissionId.get(code);
            if (!id) throw new Error(`Permission "${code}" is not in the database - run: npx prisma db seed`);
            return { roleId: role.id, permissionId: id, tenantId: org.id };
          }),
        });
      }
      if (!ownerRoleId) throw new Error('DEFAULT_ROLES must contain an "owner" role');

      // 3. the creator joins the school as its owner
      await tx.membership.create({
        data: {
          tenantId: org.id,
          userId: user.id,
          roles: { create: [{ roleId: ownerRoleId, tenantId: org.id }] },
        },
      });
      return org;
    });

    return { id: org.id, slug: org.slug, name: org.name, timezone: org.timezone, roles: ['owner'] };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HttpError(409, 'An organization with this slug already exists');
    }
    throw e;
  }
}

// "The school I am acting in right now."
export async function currentOrganization(tenant: TenantContext): Promise<unknown> {
  const org = await prisma.organization.findFirst({
    where: { id: tenant.id },
    select: { id: true, slug: true, name: true, timezone: true, status: true, createdAt: true },
  });
  if (!org) throw new HttpError(404, 'Organization not found');
  return { ...org, myRoles: tenant.roles, myPermissions: [...tenant.permissions].sort() };
}

export async function updateCurrentOrganization(tenant: TenantContext, input: UpdateOrganizationInput): Promise<unknown> {
  // updateMany lets us filter by id; the id comes from the VERIFIED tenant, never from the request.
  const { count } = await prisma.organization.updateMany({
    where: { id: tenant.id, deletedAt: null },
    data: { name: input.name, timezone: input.timezone }, // undefined = leave unchanged
  });
  if (!count) throw new HttpError(404, 'Organization not found');
  return currentOrganization(tenant);
}
