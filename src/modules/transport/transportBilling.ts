import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, lte } from 'drizzle-orm';
import { db } from '../../db';
import {
  admissions, classes, drivers, feeTypes, invoiceLines, invoices, pickupPoints, routeSchedules,
  students, transportAssignments, transportRoutes, vehicles,
} from '../../db/schema';
import { parseId } from '../../lib/bigint';
import { created, ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { DIRECTIONS } from './transport.schemas';
import { createAssignment } from './transport.service';

// TRANSPORT BILLING.
// A transport assignment becomes a monthly invoice with one "Transport Fee" line, so the student's
// Fees screen, UPI payments and Approve Payments all work with no change. Only ACTIVE student
// assignments are billed, so a student who leaves stops being billed from the next month.
// Invoice number is fixed per (assignment, month), so nobody is billed twice. Safe to run again.

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** The "Transport Fee" fee type: found, or created the first time it is needed. */
async function transportFeeTypeId(tenantId: bigint): Promise<bigint> {
  const [found] = await db
    .select({ id: feeTypes.id })
    .from(feeTypes)
    .where(and(eq(feeTypes.tenantId, tenantId), eq(feeTypes.code, 'TRANSPORT')))
    .limit(1);
  if (found) return found.id;
  const [row] = await db
    .insert(feeTypes)
    .values({
      tenantId,
      code: 'TRANSPORT',
      name: 'Transport Fee',
      category: 'transport',
      frequency: 'monthly',
      isMandatory: false,
    })
    .returning({ id: feeTypes.id });
  return row.id;
}

/** Students who asked for transport at admission and have no active assignment yet. */
export async function listTransportRequests(tenant: TenantContext) {
  const rows = await db
    .select({
      admissionId: admissions.id,
      studentId: students.id,
      admissionNo: students.admissionNo,
      fullName: students.fullName,
      firstName: students.firstName,
      className: classes.name,
    })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .leftJoin(classes, eq(admissions.classId, classes.id))
    .where(
      and(
        eq(admissions.tenantId, tenant.id),
        eq(admissions.needsTransport, true),
        isNull(admissions.deletedAt),
        eq(students.tenantId, tenant.id),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    )
    .orderBy(asc(students.fullName))
    .limit(500);

  const assigned = await db
    .select({ studentId: transportAssignments.studentId })
    .from(transportAssignments)
    .where(
      and(
        eq(transportAssignments.tenantId, tenant.id),
        eq(transportAssignments.status, 'active'),
        isNotNull(transportAssignments.studentId),
      ),
    );
  const taken = new Set(assigned.map((a) => String(a.studentId)));

  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const key = String(r.studentId);
      if (taken.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      id: String(r.studentId),
      studentId: String(r.studentId),
      admissionId: String(r.admissionId),
      admissionNo: r.admissionNo,
      name: r.fullName || r.firstName,
      className: r.className ?? '',
    }));
}

/** Bills one month (YYYY-MM) for every active student assignment. */
export async function billMonth(tenant: TenantContext, month: string, onlyStudentId?: bigint) {
  const feeTypeId = await transportFeeTypeId(tenant.id);

  const allActive = await db
    .select({
      id: transportAssignments.id,
      studentId: transportAssignments.studentId,
      academicYearId: transportAssignments.academicYearId,
      monthlyFee: transportAssignments.monthlyFee,
    })
    .from(transportAssignments)
    .innerJoin(students, eq(transportAssignments.studentId, students.id))
    .where(
      and(
        eq(transportAssignments.tenantId, tenant.id),
        eq(transportAssignments.status, 'active'),
        isNotNull(transportAssignments.studentId),
        eq(students.tenantId, tenant.id),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    );

  const list = onlyStudentId === undefined
    ? allActive
    : allActive.filter((a) => String(a.studentId) === String(onlyStudentId));
  const result = { month, assignments: list.length, created: 0, updated: 0, skipped: 0, total: '0.00' };
  if (list.length === 0) return result;

  const issuedOn = `${month}-01`;
  const today = todayStr();
  const tenth = `${month}-10`;
  const dueOn = tenth >= today ? tenth : addDays(today, 10);

  const numberOf = (assignmentId: bigint) => `TR${assignmentId}-${month}`;
  const existing = await db
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenant.id), inArray(invoices.number, list.map((a) => numberOf(a.id)))));
  const byNumber = new Map(existing.map((e) => [e.number, e]));

  const lineFor = (invoiceId: bigint, fee: string) => ({
    tenantId: tenant.id,
    invoiceId,
    lineType: 'fee',
    feeTypeId,
    quantity: '1.00',
    unitAmount: fee,
    discountAmount: '0.00',
    taxAmount: '0.00',
    lineTotal: fee,
  });

  let total = 0;
  await db.transaction(async (tx) => {
    for (const a of list) {
      const fee = Number(a.monthlyFee).toFixed(2);
      if (Number(fee) <= 0 || a.studentId === null) {
        result.skipped += 1;
        continue;
      }
      const number = numberOf(a.id);
      const found = byNumber.get(number);

      if (!found) {
        const [inv] = await tx
          .insert(invoices)
          .values({
            tenantId: tenant.id,
            number,
            studentId: a.studentId,
            academicYearId: a.academicYearId,
            issuedOn,
            dueOn,
            status: 'issued',
          })
          .returning({ id: invoices.id });
        await tx.insert(invoiceLines).values(lineFor(inv.id, fee));
        result.created += 1;
        total += Number(fee);
        continue;
      }

      if (found.status === 'paid' || found.status === 'void') {
        result.skipped += 1;
        continue;
      }

      await tx.delete(invoiceLines).where(and(eq(invoiceLines.tenantId, tenant.id), eq(invoiceLines.invoiceId, found.id)));
      await tx.insert(invoiceLines).values(lineFor(found.id, fee));
      result.updated += 1;
      total += Number(fee);
    }
  });

  result.total = total.toFixed(2);
  return result;
}

// ---- /api/transport-billing
export const transportBillingRouter = Router();

const billSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() }).strict();

transportBillingRouter.get('/requests', requirePermission('transport.view'), async (req, res) => {
  ok(res, await listTransportRequests(currentTenant(req)));
});

transportBillingRouter.post('/bill', requirePermission('finance.edit'), async (req, res) => {
  const body = billSchema.parse(req.body ?? {});
  ok(res, await billMonth(currentTenant(req), body.month ?? todayStr().slice(0, 7)));
});

// ---- "Bill Transport Fees" screen: this month, next month and the last two months
export async function listBillingMonths(tenant: TenantContext) {
  const [active] = await db
    .select({ n: count() })
    .from(transportAssignments)
    .where(
      and(
        eq(transportAssignments.tenantId, tenant.id),
        eq(transportAssignments.status, 'active'),
        isNotNull(transportAssignments.studentId),
      ),
    );

  const now = new Date();
  const out: { id: string; name: string; activeStudents: number; invoicesIssued: number }[] = [];
  for (const back of [0, -1, 1, 2]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = d.toISOString().slice(0, 7);
    const [issued] = await db
      .select({ n: count() })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.id), like(invoices.number, `TR%-${month}`)));
    out.push({
      id: month,
      name: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      activeStudents: Number(active.n),
      invoicesIssued: Number(issued.n),
    });
  }
  return out;
}

transportBillingRouter.get('/months', requirePermission('finance.view'), async (req, res) => {
  ok(res, await listBillingMonths(currentTenant(req)));
});

transportBillingRouter.post('/months/:month/bill', requirePermission('finance.edit'), async (req, res) => {
  const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').parse(req.params.month);
  ok(res, await billMonth(currentTenant(req), month));
});

// ---- assign transport to a student who asked for it at admission
const feeInput = z.preprocess(
  (v) => (v === '' || v === null ? undefined : typeof v === 'string' ? Number(v) : v),
  z.number().min(0).max(10_000_000).optional(),
);
const assignSchema = z.object({
  academicYearId: z.coerce.bigint().positive(),
  routeId: z.coerce.bigint().positive(),
  pickupPointId: z.coerce.bigint().positive(),
  direction: z.enum(DIRECTIONS).optional(),
  monthlyFee: feeInput,
});

transportBillingRouter.post('/requests/:studentId/assign', requirePermission('transport.create'), async (req, res) => {
  const input = assignSchema.parse(req.body ?? {});
  const row = await createAssignment(currentTenant(req), currentUser(req), {
    ...input,
    studentId: parseId(req.params.studentId),
  });
  // bill this month right away, so the fee shows in the student's Fees (a billing problem must not undo the assignment)
  let billing: Awaited<ReturnType<typeof billMonth>> | null = null;
  try {
    billing = await billMonth(currentTenant(req), todayStr().slice(0, 7), parseId(req.params.studentId));
  } catch {
    billing = null;
  }
  created(res, { assignment: row, billing });
});

// ---- "My Transport": the signed-in student's own transport (own login only, no permission needed)
export async function getMyTransport(tenant: TenantContext, actor: ReturnType<typeof currentUser>) {
  const [me] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.tenantId, tenant.id), eq(students.userId, actor.id), isNull(students.deletedAt)))
    .limit(1);
  if (!me) return { status: 'No student record is linked to this login' };

  const [a] = await db
    .select({
      direction: transportAssignments.direction,
      monthlyFee: transportAssignments.monthlyFee,
      routeId: transportAssignments.routeId,
      routeCode: transportRoutes.code,
      routeName: transportRoutes.name,
      pickupPoint: pickupPoints.name,
      landmark: pickupPoints.landmark,
      pickupTime: pickupPoints.pickupTime,
      dropTime: pickupPoints.dropTime,
    })
    .from(transportAssignments)
    .innerJoin(transportRoutes, eq(transportAssignments.routeId, transportRoutes.id))
    .innerJoin(pickupPoints, eq(transportAssignments.pickupPointId, pickupPoints.id))
    .where(
      and(
        eq(transportAssignments.tenantId, tenant.id),
        eq(transportAssignments.studentId, me.id),
        eq(transportAssignments.status, 'active'),
      ),
    )
    .orderBy(desc(transportAssignments.id))
    .limit(1);

  if (!a) {
    const [asked] = await db
      .select({ id: admissions.id })
      .from(admissions)
      .where(
        and(
          eq(admissions.tenantId, tenant.id),
          eq(admissions.studentId, me.id),
          eq(admissions.needsTransport, true),
          isNull(admissions.deletedAt),
        ),
      )
      .limit(1);
    return {
      status: asked
        ? 'Requested: waiting for the school to assign your route and stop'
        : 'You are not using school transport',
    };
  }

  const today = todayStr();
  const [s] = await db
    .select({
      registrationNo: vehicles.registrationNo,
      vehicleType: vehicles.vehicleType,
      driver: drivers.fullName,
      driverPhone: drivers.phone,
    })
    .from(routeSchedules)
    .innerJoin(vehicles, eq(routeSchedules.vehicleId, vehicles.id))
    .innerJoin(drivers, eq(routeSchedules.driverId, drivers.id))
    .where(
      and(
        eq(routeSchedules.tenantId, tenant.id),
        eq(routeSchedules.routeId, a.routeId),
        lte(routeSchedules.validFrom, today),
        gte(routeSchedules.validTo, today),
      ),
    )
    .limit(1);

  return {
    status: 'Assigned',
    route: `${a.routeCode} - ${a.routeName}`,
    pickupPoint: a.pickupPoint,
    landmark: a.landmark,
    pickupTime: a.pickupTime ? String(a.pickupTime).slice(0, 5) : null,
    dropTime: a.dropTime ? String(a.dropTime).slice(0, 5) : null,
    direction: a.direction,
    monthlyFee: 'Rs ' + Number(a.monthlyFee).toFixed(2),
    vehicle: s ? `${s.registrationNo} (${s.vehicleType})` : null,
    driver: s?.driver ?? null,
    driverPhone: s?.driverPhone ?? null,
  };
}

transportBillingRouter.get('/me', async (req, res) => {
  ok(res, await getMyTransport(currentTenant(req), currentUser(req)));
});
