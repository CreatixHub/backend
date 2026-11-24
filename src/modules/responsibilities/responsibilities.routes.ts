import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ensureClassAccessTable } from '../../lib/classAccess';
import { db } from '../../db';
import { classes, membershipRoles, memberships, permissions, rolePermissions, roles, staff } from '../../db/schema';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';

export const responsibilitiesRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Opt = {
  code: string;
  label: string;
  description: string;
  danger?: boolean;
  create?: { name: string; perms: string[] };
};

// Each responsibility = one role in this school. System roles are reused; the others are created on first use.
const CATALOG: Opt[] = [
  { code: 'admin', label: 'Administrator', description: 'Full access to every module, the same as the admin.', danger: true },
  {
    code: 'admission_officer',
    label: 'Admissions',
    description: 'Manage student admissions.',
    create: { name: 'Admission Officer', perms: ['admissions.view', 'admissions.create', 'admissions.edit', 'students.view', 'classes.view'] },
  },
  { code: 'accountant', label: 'Fees and finance', description: 'Fee structures, invoices, payments and expenses.' },
  { code: 'transport_manager', label: 'Transport', description: 'Vehicles, drivers, routes and transport fees.' },
  {
    code: 'gatepass_officer',
    label: 'Gate pass',
    description: 'Create and approve gate passes.',
    create: { name: 'Gate Pass Officer', perms: ['gatepass.view', 'gatepass.create', 'gatepass.edit', 'gatepass.approve'] },
  },
  {
    code: 'asset_manager',
    label: 'Assets',
    description: 'Manage school assets, allocations and maintenance.',
    create: { name: 'Asset Manager', perms: ['assets.view', 'assets.create', 'assets.edit', 'assets.delete'] },
  },
];

const isAdmin = (t: TenantContext) => t.permissions.has('*') || t.roles.includes('admin');

async function loadStaff(tenant: TenantContext, staffId: bigint) {
  const [s] = await db
    .select({ id: staff.id, fullName: staff.fullName, userId: staff.userId })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
    .limit(1);
  if (!s) throw new HttpError(404, 'Staff member not found');
  return s;
}

async function membershipOf(tenant: TenantContext, userId: bigint) {
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, userId)))
    .limit(1);
  return m ?? null;
}

async function roleCodesOf(membershipId: bigint): Promise<string[]> {
  const rows = await db
    .select({ code: roles.code })
    .from(membershipRoles)
    .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
    .where(eq(membershipRoles.membershipId, membershipId));
  return rows.map((r) => r.code);
}

async function ensureRole(tx: Tx, tenant: TenantContext, opt: Opt): Promise<bigint> {
  const [r] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenantId, tenant.id), eq(roles.code, opt.code)))
    .limit(1);
  if (r) return r.id;
  if (!opt.create) throw new HttpError(400, `The role for "${opt.label}" does not exist in this school`);
  const [nr] = await tx
    .insert(roles)
    .values({ tenantId: tenant.id, code: opt.code, name: opt.create.name, description: opt.description, isSystem: false })
    .returning({ id: roles.id });
  const perms = await tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, opt.create.perms));
  if (perms.length) {
    await tx.insert(rolePermissions).values(perms.map((p) => ({ roleId: nr.id, permissionId: p.id, tenantId: tenant.id })));
  }
  return nr.id;
}

// GET: the choices and which ones this staff member has
responsibilitiesRouter.get('/staff/:staffId', async (req, res) => {
  const tenant = currentTenant(req);
  if (!isAdmin(tenant)) throw new HttpError(403, 'Only the admin can manage responsibilities');
  const s = await loadStaff(tenant, parseId(req.params.staffId));
  let assigned: string[] = [];
  let hasLogin = false;
  if (s.userId != null) {
    const m = await membershipOf(tenant, s.userId);
    if (m) {
      hasLogin = true;
      assigned = await roleCodesOf(m.id);
    }
  }
  ok(res, {
    staff: { id: s.id, name: s.fullName },
    hasLogin,
    catalog: CATALOG.map((c) => ({
      code: c.code,
      label: c.label,
      description: c.description,
      danger: !!c.danger,
      assigned: assigned.includes(c.code),
    })),
  });
});

// PUT: set the full list of extra responsibilities
const putSchema = z.object({ codes: z.array(z.string().trim().min(1)).max(20) }).strict();

responsibilitiesRouter.put('/staff/:staffId', async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  if (!isAdmin(tenant)) throw new HttpError(403, 'Only the admin can manage responsibilities');
  const body = putSchema.parse(req.body);
  const wanted = [...new Set(body.codes)];
  const bad = wanted.filter((c) => !CATALOG.some((o) => o.code === c));
  if (bad.length) throw new HttpError(400, `Unknown responsibility: ${bad.join(', ')}`);

  const s = await loadStaff(tenant, parseId(req.params.staffId));
  if (s.userId == null) throw new HttpError(400, 'This staff member has no login yet. Add them in Members first.');
  if (s.userId === user.id) throw new HttpError(400, 'You cannot change your own access');
  const m = await membershipOf(tenant, s.userId);
  if (!m) throw new HttpError(400, 'This staff member has no login in this school. Add them in Members first.');

  const current = await roleCodesOf(m.id);
  if (current.includes('owner')) throw new HttpError(403, 'The owner cannot be changed');

  const managed = CATALOG.map((c) => c.code);
  const toAdd = wanted.filter((c) => !current.includes(c));
  const toRemove = current.filter((c) => managed.includes(c) && !wanted.includes(c));

  if (toRemove.includes('admin')) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(
          eq(memberships.tenantId, tenant.id),
          eq(memberships.status, 'active'),
          ne(memberships.id, m.id),
          inArray(roles.code, ['owner', 'admin']),
        ),
      );
    if (total < 1) throw new HttpError(400, 'The school must keep at least one administrator');
  }

  await db.transaction(async (tx) => {
    for (const code of toAdd) {
      const opt = CATALOG.find((o) => o.code === code)!;
      const roleId = await ensureRole(tx, tenant, opt);
      await tx.insert(membershipRoles).values({ membershipId: m.id, roleId, tenantId: tenant.id }).onConflictDoNothing();
    }
    if (toRemove.length) {
      const rm = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), inArray(roles.code, toRemove)));
      if (rm.length) {
        await tx.delete(membershipRoles).where(
          and(eq(membershipRoles.membershipId, m.id), inArray(membershipRoles.roleId, rm.map((r) => r.id))),
        );
      }
    }
  });

  const after = await roleCodesOf(m.id);
  ok(res, { assigned: after.filter((c) => managed.includes(c)) });
});

// ---- Class access: which classes an Admission Officer can see ----
responsibilitiesRouter.get('/staff/:staffId/classes', async (req, res) => {
  const tenant = currentTenant(req);
  if (!isAdmin(tenant)) throw new HttpError(403, 'Only the admin can manage responsibilities');
  await ensureClassAccessTable();
  const s = await loadStaff(tenant, parseId(req.params.staffId));
  const all = await db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.tenantId, tenant.id)).orderBy(classes.name);
  const r: any = await db.execute(
    sql`select class_id from staff_class_access where tenant_id = ${String(tenant.id)}::bigint and staff_id = ${String(s.id)}::bigint`,
  );
  const rows: any[] = Array.isArray(r) ? r : (r.rows ?? []);
  const chosen = new Set(rows.map((x) => String(x.class_id)));
  ok(res, { classes: all.map((c) => ({ id: String(c.id), name: c.name, selected: chosen.has(String(c.id)) })) });
});

const classesSchema = z.object({ classIds: z.array(z.string().regex(/^\d+$/)).max(500) }).strict();

responsibilitiesRouter.put('/staff/:staffId/classes', async (req, res) => {
  const tenant = currentTenant(req);
  if (!isAdmin(tenant)) throw new HttpError(403, 'Only the admin can manage responsibilities');
  await ensureClassAccessTable();
  const body = classesSchema.parse(req.body);
  const s = await loadStaff(tenant, parseId(req.params.staffId));
  const valid = await db.select({ id: classes.id }).from(classes).where(eq(classes.tenantId, tenant.id));
  const validSet = new Set(valid.map((c) => String(c.id)));
  const wanted = [...new Set(body.classIds)].filter((c) => validSet.has(c));
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from staff_class_access where tenant_id = ${String(tenant.id)}::bigint and staff_id = ${String(s.id)}::bigint`);
    for (const cid of wanted) {
      await tx.execute(
        sql`insert into staff_class_access (tenant_id, staff_id, class_id) values (${String(tenant.id)}::bigint, ${String(s.id)}::bigint, ${cid}::bigint) on conflict do nothing`,
      );
    }
  });
  ok(res, { classIds: wanted });
});