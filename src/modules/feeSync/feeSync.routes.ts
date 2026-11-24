import { Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, feeStructures, invoices, students } from '../../db/schema';
import { parseId } from '../../lib/bigint';
import { ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { invoiceNumber, publishStructure } from '../feeCollection/feeCollection.service';

export const feeSyncRouter = Router();

async function activeKids(tenantId: bigint, classId: bigint) {
  return db
    .selectDistinct({ id: students.id, name: students.fullName, admissionNo: students.admissionNo })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(admissions.tenantId, tenantId),
        eq(admissions.classId, classId),
        isNull(admissions.deletedAt),
        eq(students.tenantId, tenantId),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    )
    .orderBy(asc(students.fullName));
}

// For every active fee structure: the class, its students and who has no invoice yet.
feeSyncRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const structures = await db
    .select({ id: feeStructures.id, classId: feeStructures.classId, className: classes.name, name: feeStructures.name })
    .from(feeStructures)
    .innerJoin(classes, eq(feeStructures.classId, classes.id))
    .where(and(eq(feeStructures.tenantId, tenant.id), eq(feeStructures.status, 'active')))
    .orderBy(asc(classes.id), asc(feeStructures.id));

  const out = [];
  for (const s of structures) {
    const kids = await activeKids(tenant.id, s.classId);
    const nums = kids.map((k) => invoiceNumber(s.id, k.id));
    const have = nums.length
      ? await db
          .select({ number: invoices.number })
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenant.id), inArray(invoices.number, nums)))
      : [];
    const haveSet = new Set(have.map((h) => h.number));
    const missing = kids.filter((k) => !haveSet.has(invoiceNumber(s.id, k.id)));
    out.push({
      structureId: String(s.id),
      className: s.className,
      name: s.name ?? '',
      students: kids.length,
      missing: missing.map((m) => ({ id: String(m.id), name: m.name ?? '', admissionNo: m.admissionNo ?? '' })),
    });
  }
  ok(res, { structures: out });
});

// Create invoices only for students who do not have one. Existing invoices are not touched.
feeSyncRouter.post('/:id/generate-new', requirePermission('finance.edit'), async (req, res) => {
  ok(res, await publishStructure(currentTenant(req), parseId(req.params.id), true));
});