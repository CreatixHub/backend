import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, feeStructureItems, feeStructures, feeTypes, invoiceLines, invoices, students } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';

// FEES BY CLASS.
// The admin sets the fee items of a class (a fee structure). "Publish" then gives every active
// student of that class one invoice for those items. Running it again is safe:
//   - a student with no invoice yet gets one,
//   - a student whose invoice is still open gets it refreshed to the current amounts,
//   - paid / void invoices are left alone.
// The invoice number is fixed per (structure, student), so nobody is ever billed twice.

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
export const invoiceNumber = (structureId: bigint, studentId: bigint) => `FS${structureId}-S${studentId}`;

export async function publishStructure(tenant: TenantContext, structureId: bigint, onlyNew = false) {
  const [structure] = await db
    .select({
      id: feeStructures.id,
      classId: feeStructures.classId,
      className: classes.name,
      academicYearId: feeStructures.academicYearId,
      status: feeStructures.status,
    })
    .from(feeStructures)
    .innerJoin(classes, eq(feeStructures.classId, classes.id))
    .where(and(eq(feeStructures.id, structureId), eq(feeStructures.tenantId, tenant.id)))
    .limit(1);
  if (!structure) throw new HttpError(404, 'Fee structure not found');
  if (structure.status !== 'active') throw new HttpError(400, 'This fee structure is not active');

  // only the compulsory items are billed
  const items = (
    await db
      .select()
      .from(feeStructureItems)
      .where(and(eq(feeStructureItems.tenantId, tenant.id), eq(feeStructureItems.feeStructureId, structureId)))
      .orderBy(asc(feeStructureItems.id))
  ).filter((i) => !i.isOptional);
  if (items.length === 0) throw new HttpError(400, 'Add at least one compulsory fee item to this class first');

  const kids = await db
    .selectDistinct({ id: students.id })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(admissions.tenantId, tenant.id),
        eq(admissions.classId, structure.classId),
        isNull(admissions.deletedAt),
        eq(students.tenantId, tenant.id),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    );

  const perStudent = items.reduce((sum, i) => sum + Number(i.amount), 0);
  const result = {
    structureId: String(structure.id),
    classId: String(structure.classId),
    className: structure.className,
    students: kids.length,
    created: 0,
    updated: 0,
    skipped: 0,
    perStudentTotal: perStudent.toFixed(2),
  };
  if (kids.length === 0) return result;

  const issuedOn = todayStr();
  const dueDates = items.map((i) => i.dueOn).filter((d): d is string => !!d).sort();
  const dueOn = dueDates[0] ?? addDays(issuedOn, 30);

  const numbers = kids.map((k) => invoiceNumber(structure.id, k.id));
  const existing = await db
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenant.id), inArray(invoices.number, numbers)));
  const byNumber = new Map(existing.map((e) => [e.number, e]));

  const lineRows = (invoiceId: bigint) =>
    items.map((i) => ({
      tenantId: tenant.id,
      invoiceId,
      lineType: 'fee',
      feeTypeId: i.feeTypeId,
      quantity: '1.00',
      unitAmount: Number(i.amount).toFixed(2),
      discountAmount: '0.00',
      taxAmount: '0.00',
      lineTotal: Number(i.amount).toFixed(2),
    }));

  await db.transaction(async (tx) => {
    for (const k of kids) {
      const number = invoiceNumber(structure.id, k.id);
      const found = byNumber.get(number);

      if (!found) {
        const [inv] = await tx
          .insert(invoices)
          .values({
            tenantId: tenant.id,
            number,
            studentId: k.id,
            academicYearId: structure.academicYearId,
            issuedOn,
            dueOn,
            status: 'issued',
          })
          .returning({ id: invoices.id });
        await tx.insert(invoiceLines).values(lineRows(inv.id));
        result.created += 1;
        continue;
      }

      if (onlyNew || found.status === 'paid' || found.status === 'void') {
        result.skipped += 1;
        continue;
      }

      await tx.delete(invoiceLines).where(and(eq(invoiceLines.tenantId, tenant.id), eq(invoiceLines.invoiceId, found.id)));
      await tx.insert(invoiceLines).values(lineRows(found.id));
      await tx
        .update(invoices)
        .set({ dueOn })
        .where(and(eq(invoices.id, found.id), eq(invoices.tenantId, tenant.id)));
      result.updated += 1;
    }
  });

  return result;
}

// ------------------------------------------------------------------ list for the admin "Fee Structures" screen
// Same rows as /fee-structures, plus what the admin needs to SEE: the class name, the amounts and the total.
const inr = (n: number) => 'Rs ' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export async function listStructuresWithAmounts(tenant: TenantContext) {
  const structures = await db
    .select({ s: feeStructures, className: classes.name })
    .from(feeStructures)
    .innerJoin(classes, eq(feeStructures.classId, classes.id))
    .where(eq(feeStructures.tenantId, tenant.id))
    .orderBy(asc(classes.gradeLevel), asc(classes.name), asc(feeStructures.id))
    .limit(200);
  if (structures.length === 0) return [];

  const structureIds = structures.map((r) => r.s.id);
  const items = await db
    .select({
      structureId: feeStructureItems.feeStructureId,
      amount: feeStructureItems.amount,
      isOptional: feeStructureItems.isOptional,
      typeName: feeTypes.name,
    })
    .from(feeStructureItems)
    .innerJoin(feeTypes, eq(feeStructureItems.feeTypeId, feeTypes.id))
    .where(and(eq(feeStructureItems.tenantId, tenant.id), inArray(feeStructureItems.feeStructureId, structureIds)))
    .orderBy(asc(feeStructureItems.id));

  const classIds = [...new Set(structures.map((r) => r.s.classId))];
  const counts = await db
    .select({ classId: admissions.classId, n: count() })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(admissions.tenantId, tenant.id),
        isNull(admissions.deletedAt),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
        inArray(admissions.classId, classIds),
      ),
    )
    .groupBy(admissions.classId);
  const studentsIn = new Map(counts.map((c) => [String(c.classId), Number(c.n)]));

  return structures.map(({ s, className }) => {
    const mine = items.filter((i) => i.structureId === s.id);
    const compulsory = mine.filter((i) => !i.isOptional);
    const total = compulsory.reduce((sum, i) => sum + Number(i.amount), 0);
    return {
      // shown first (the list screen displays the first few fields)
      name: s.name || `${className} fees`,
      className,
      totalPerStudent: mine.length === 0 ? 'No amount added yet' : inr(total),
      feeItems: mine.length === 0 ? '-' : mine.map((i) => `${i.typeName} ${inr(Number(i.amount))}${i.isOptional ? ' (optional)' : ''}`).join(', '),
      studentsInClass: studentsIn.get(String(s.classId)) ?? 0,
      frequency: s.frequency,
      // used by Edit and the buttons
      id: String(s.id),
      classId: String(s.classId),
      academicYearId: String(s.academicYearId),
      code: s.code,
      description: s.description,
      effectiveFrom: s.effectiveFrom,
      status: s.status,
    };
  });
}