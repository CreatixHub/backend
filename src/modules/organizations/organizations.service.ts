import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { DEFAULT_ROLES } from '../../permissions';
import type { CreateOrganizationInput, UpdateOrganizationInput } from './organizations.schemas';

// CREATE A SCHOOL. The signed-in person becomes its owner. ONE transaction: if any step fails, nothing is saved.
export async function createOrganization(input: CreateOrganizationInput, user: AuthUser, ip?: string): Promise<unknown> {
  // try { const org = await prisma.$transaction(async (tx) => {  ...use tx, NOT prisma, inside...  })
  //   TODO 1: const org = await tx.organization.create({ data: { slug: input.slug, name: input.name, timezone: input.timezone ?? 'UTC' } })
  //   TODO 2: const permissions = await tx.permission.findMany();  build a Map code -> id
  //   TODO 3: for (const def of DEFAULT_ROLES):
  //             const role = await tx.role.create({ data: { tenantId: org.id, code: def.code, name: def.name, description: def.description, isSystem: true } })
  //             remember role.id of 'owner'
  //             await tx.rolePermission.createMany({ data: def.permissions.map(code => ({ roleId: role.id, permissionId: <id of code>, tenantId: org.id })) })
  //             a code missing from the map -> throw new Error('Permission "x" is not in the database - run: npx prisma db seed')
  //   TODO 4: await tx.membership.create({ data: { tenantId: org.id, userId: user.id, roles: { create: [{ roleId: ownerRoleId, tenantId: org.id }] } } })
  //   return org })
  //   TODO 5: return { id: org.id, slug: org.slug, name: org.name, timezone: org.timezone, roles: ['owner'] }
  // } catch (e) { P2002 -> throw new HttpError(409, 'An organization with this slug already exists'); else rethrow }
  void Prisma; void prisma; void HttpError; void DEFAULT_ROLES; void input; void user; void ip;
  throw new Error('TODO C10b: createOrganization');
}

// "The school I am acting in right now."
export async function currentOrganization(tenant: TenantContext): Promise<unknown> {
  // TODO: prisma.organization.findFirst({ where: { id: tenant.id }, select: { id, slug, name, timezone, status, createdAt } })
  //       none -> HttpError(404, 'Organization not found')
  //       return { ...org, myRoles: tenant.roles, myPermissions: [...tenant.permissions].sort() }
  void tenant;
  throw new Error('TODO C10d: currentOrganization');
}

export async function updateCurrentOrganization(tenant: TenantContext, input: UpdateOrganizationInput): Promise<unknown> {
  // TODO: const { count } = await prisma.organization.updateMany({ where: { id: tenant.id, deletedAt: null },
  //         data: { name: input.name, timezone: input.timezone } })      // undefined = unchanged; the tenant id comes from the VERIFIED tenant
  //       count === 0 -> HttpError(404, 'Organization not found'); return currentOrganization(tenant)
  void tenant; void input;
  throw new Error('TODO C10d: updateCurrentOrganization');
}
