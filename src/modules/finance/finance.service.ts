import crypto from 'node:crypto';
import { and, asc, count, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  classes,
  feeAssignments,
  feeGroups,
  feeInstallments,
  feeStructureItems,
  feeStructures,
  feeTypes,
  invoiceLines,
  invoices,
  payments,
  students,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { assertStudentReadable, isRowScopedFor, resolveStudentScope, studentScopeCondition } from '../../lib/ownership';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateFeeAssignmentInput,
  CreateFeeGroupInput,
  CreateFeeStructureInput,
  CreateFeeTypeInput,
  CreateInvoiceInput,
  CreatePaymentInput,
  FeeInstallmentInput,
  FeeStructureItemInput,
  GenerateInvoiceFromStructureInput,
  InvoiceLineInput,
  ListFeeAssignmentsInput,
  ListFeeGroupsInput,
  ListFeeStructuresInput,
  ListFeeTypesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  UpdateFeeAssignmentInput,
  UpdateFeeGroupInput,
  UpdateFeeInstallmentInput,
  UpdateFeeStructureInput,
  UpdateFeeStructureItemInput,
  UpdateFeeTypeInput,
  UpdateInvoiceInput,
  UpdatePaymentInput,
} from './finance.schemas';

const toRow = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const fixed2 = (n: number | null | undefined): string | null | undefined => (n == null ? n : n.toFixed(2));
const genCode = (prefix: string) =>
  `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

function computeLineTotal(line: InvoiceLineInput): string {
  const gross = line.quantity * line.unitAmount;
  const raw = line.lineType === 'discount' ? -(gross - line.discountAmount + line.taxAmount) : gross - line.discountAmount + line.taxAmount;
  return raw.toFixed(2);
}

async function assertClassInTenant(tenantId: bigint, classId: bigint) {
  const [row] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId), isNull(classes.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Class not found in this school');
}

async function assertStudentInTenant(tenantId: bigint, studentId: bigint) {
  const [row] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Student not found in this school');
}

async function assertFeeTypeInTenant(tenantId: bigint, feeTypeId: bigint) {
  const [row] = await db
    .select({ id: feeTypes.id })
    .from(feeTypes)
    .where(and(eq(feeTypes.id, feeTypeId), eq(feeTypes.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Fee type not found in this school');
}

async function assertFeeStructureInTenant(tenantId: bigint, feeStructureId: bigint) {
  const [row] = await db
    .select()
    .from(feeStructures)
    .where(and(eq(feeStructures.id, feeStructureId), eq(feeStructures.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Fee structure not found');
  return row;
}

// ================================================================ FEE GROUPS
export async function listFeeGroups(tenant: TenantContext, q: ListFeeGroupsInput) {
  const conditions = [eq(feeGroups.tenantId, tenant.id)];
  if (q.isActive !== undefined) conditions.push(eq(feeGroups.isActive, q.isActive));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(feeGroups.name, pattern), ilike(feeGroups.code, pattern));
    if (searchCond) conditions.push(searchCond);
  }
  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(feeGroups).where(where);
  const rows = await db
    .select()
    .from(feeGroups)
    .where(where)
    .orderBy(asc(feeGroups.displayOrder), asc(feeGroups.name))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getFeeGroup(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(feeGroups)
    .where(and(eq(feeGroups.id, id), eq(feeGroups.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Fee group not found');
  return toRow(row);
}

export async function createFeeGroup(tenant: TenantContext, data: CreateFeeGroupInput) {
  try {
    const [row] = await db
      .insert(feeGroups)
      .values({
        tenantId: tenant.id,
        name: data.name,
        code: data.code ?? null,
        category: data.category,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A fee group with this name already exists');
    throw e;
  }
}

export async function updateFeeGroup(tenant: TenantContext, id: bigint, data: UpdateFeeGroupInput) {
  const [existing] = await db
    .select({ id: feeGroups.id })
    .from(feeGroups)
    .where(and(eq(feeGroups.id, id), eq(feeGroups.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Fee group not found');

  const patch: Partial<typeof feeGroups.$inferInsert> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.code !== undefined) patch.code = data.code;
  if (data.category !== undefined) patch.category = data.category;
  if (data.displayOrder !== undefined) patch.displayOrder = data.displayOrder;
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  try {
    const [updated] = await db
      .update(feeGroups)
      .set(patch)
      .where(and(eq(feeGroups.id, id), eq(feeGroups.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A fee group with this name already exists');
    throw e;
  }
}

export async function deleteFeeGroup(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(feeGroups)
    .where(and(eq(feeGroups.id, id), eq(feeGroups.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Fee group not found');
}

// ================================================================ FEE TYPES
export async function listFeeTypes(tenant: TenantContext, q: ListFeeTypesInput) {
  const conditions = [eq(feeTypes.tenantId, tenant.id)];
  if (q.feeGroupId !== undefined) conditions.push(eq(feeTypes.feeGroupId, q.feeGroupId));
  if (q.frequency !== undefined) conditions.push(eq(feeTypes.frequency, q.frequency));
  if (q.status !== undefined) conditions.push(eq(feeTypes.status, q.status));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(feeTypes.code, pattern), ilike(feeTypes.name, pattern));
    if (searchCond) conditions.push(searchCond);
  }
  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(feeTypes).where(where);
  const rows = await db
    .select()
    .from(feeTypes)
    .where(where)
    .orderBy(asc(feeTypes.name), asc(feeTypes.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getFeeType(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(feeTypes)
    .where(and(eq(feeTypes.id, id), eq(feeTypes.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Fee type not found');
  return toRow(row);
}

export async function createFeeType(tenant: TenantContext, data: CreateFeeTypeInput) {
  if (data.feeGroupId != null) {
    const [fg] = await db
      .select({ id: feeGroups.id })
      .from(feeGroups)
      .where(and(eq(feeGroups.id, data.feeGroupId), eq(feeGroups.tenantId, tenant.id)))
      .limit(1);
    if (!fg) throw new HttpError(400, 'Fee group not found in this school');
  }
  try {
    const [row] = await db
      .insert(feeTypes)
      .values({
        tenantId: tenant.id,
        feeGroupId: data.feeGroupId ?? null,
        code: data.code,
        name: data.name,
        category: data.category,
        frequency: data.frequency,
        isRefundable: data.isRefundable,
        isMandatory: data.isMandatory,
        lateFeeApplicable: data.lateFeeApplicable,
        defaultAmount: fixed2(data.defaultAmount) ?? null,
        status: data.status,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A fee type with this code already exists');
    throw e;
  }
}

export async function updateFeeType(tenant: TenantContext, id: bigint, data: UpdateFeeTypeInput) {
  const [existing] = await db
    .select({ id: feeTypes.id })
    .from(feeTypes)
    .where(and(eq(feeTypes.id, id), eq(feeTypes.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Fee type not found');

  if (data.feeGroupId != null) {
    const [fg] = await db
      .select({ id: feeGroups.id })
      .from(feeGroups)
      .where(and(eq(feeGroups.id, data.feeGroupId), eq(feeGroups.tenantId, tenant.id)))
      .limit(1);
    if (!fg) throw new HttpError(400, 'Fee group not found in this school');
  }

  const patch: Partial<typeof feeTypes.$inferInsert> = {};
  if (data.feeGroupId !== undefined) patch.feeGroupId = data.feeGroupId;
  if (data.code !== undefined) patch.code = data.code;
  if (data.name !== undefined) patch.name = data.name;
  if (data.category !== undefined) patch.category = data.category;
  if (data.frequency !== undefined) patch.frequency = data.frequency;
  if (data.isRefundable !== undefined) patch.isRefundable = data.isRefundable;
  if (data.isMandatory !== undefined) patch.isMandatory = data.isMandatory;
  if (data.lateFeeApplicable !== undefined) patch.lateFeeApplicable = data.lateFeeApplicable;
  if (data.defaultAmount !== undefined) patch.defaultAmount = fixed2(data.defaultAmount);
  if (data.status !== undefined) patch.status = data.status;

  try {
    const [updated] = await db
      .update(feeTypes)
      .set(patch)
      .where(and(eq(feeTypes.id, id), eq(feeTypes.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A fee type with this code already exists');
    throw e;
  }
}

export async function deleteFeeType(tenant: TenantContext, id: bigint) {
  try {
    const [deleted] = await db
      .delete(feeTypes)
      .where(and(eq(feeTypes.id, id), eq(feeTypes.tenantId, tenant.id)))
      .returning();
    if (!deleted) throw new HttpError(404, 'Fee type not found');
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(409, 'Fee type is in use and cannot be deleted');
    throw e;
  }
}

// ================================================================ FEE STRUCTURES + ITEMS + INSTALLMENTS
export async function listFeeStructures(tenant: TenantContext, q: ListFeeStructuresInput) {
  const conditions = [eq(feeStructures.tenantId, tenant.id)];
  if (q.academicYearId !== undefined) conditions.push(eq(feeStructures.academicYearId, q.academicYearId));
  if (q.classId !== undefined) conditions.push(eq(feeStructures.classId, q.classId));
  if (q.status !== undefined) conditions.push(eq(feeStructures.status, q.status));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(feeStructures.name, pattern), ilike(feeStructures.code, pattern));
    if (searchCond) conditions.push(searchCond);
  }

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(feeStructures).where(where);
  const rows = await db
    .select()
    .from(feeStructures)
    .where(where)
    .orderBy(desc(feeStructures.createdAt), asc(feeStructures.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getFeeStructure(tenant: TenantContext, id: bigint) {
  const row = await assertFeeStructureInTenant(tenant.id, id);
  const [items, installments] = await Promise.all([
    db
      .select()
      .from(feeStructureItems)
      .where(and(eq(feeStructureItems.tenantId, tenant.id), eq(feeStructureItems.feeStructureId, id)))
      .orderBy(asc(feeStructureItems.id)),
    db
      .select()
      .from(feeInstallments)
      .where(and(eq(feeInstallments.tenantId, tenant.id), eq(feeInstallments.feeStructureId, id)))
      .orderBy(asc(feeInstallments.sequence), asc(feeInstallments.id)),
  ]);
  return {
    ...toRow(row),
    items: items.map(toRow),
    installments: installments.map(toRow),
  };
}

export async function createFeeStructure(tenant: TenantContext, data: CreateFeeStructureInput) {
  await assertClassInTenant(tenant.id, data.classId);
  if (data.items) {
    for (const item of data.items) {
      await assertFeeTypeInTenant(tenant.id, item.feeTypeId);
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const [structure] = await tx
        .insert(feeStructures)
        .values({
          tenantId: tenant.id,
          academicYearId: data.academicYearId,
          classId: data.classId,
          name: data.name ?? null,
          code: data.code ?? null,
          description: data.description ?? null,
          frequency: data.frequency,
          effectiveFrom: data.effectiveFrom ?? null,
          status: data.status,
        })
        .returning();

      const items =
        data.items && data.items.length > 0
          ? await tx
              .insert(feeStructureItems)
              .values(
                data.items.map((i) => ({
                  tenantId: tenant.id,
                  feeStructureId: structure.id,
                  feeTypeId: i.feeTypeId,
                  amount: i.amount.toFixed(2),
                  isOptional: i.isOptional,
                  dueOn: i.dueOn ?? null,
                })),
              )
              .returning()
          : [];

      const installments =
        data.installments && data.installments.length > 0
          ? await tx
              .insert(feeInstallments)
              .values(
                data.installments.map((inst) => ({
                  tenantId: tenant.id,
                  feeStructureId: structure.id,
                  name: inst.name,
                  sequence: inst.sequence,
                  dueOn: inst.dueOn,
                  percentOfTotal: inst.percentOfTotal.toFixed(2),
                })),
              )
              .returning()
          : [];

      return {
        ...toRow(structure),
        items: items.map(toRow),
        installments: installments.map(toRow),
      };
    });
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in fee structure');
    throw e;
  }
}

export async function updateFeeStructure(tenant: TenantContext, id: bigint, data: UpdateFeeStructureInput) {
  await assertFeeStructureInTenant(tenant.id, id);
  if (data.classId !== undefined) await assertClassInTenant(tenant.id, data.classId);

  const patch: Partial<typeof feeStructures.$inferInsert> = {};
  if (data.academicYearId !== undefined) patch.academicYearId = data.academicYearId;
  if (data.classId !== undefined) patch.classId = data.classId;
  if (data.name !== undefined) patch.name = data.name;
  if (data.code !== undefined) patch.code = data.code;
  if (data.description !== undefined) patch.description = data.description;
  if (data.frequency !== undefined) patch.frequency = data.frequency;
  if (data.effectiveFrom !== undefined) patch.effectiveFrom = data.effectiveFrom;
  if (data.status !== undefined) patch.status = data.status;

  try {
    const [updated] = await db
      .update(feeStructures)
      .set(patch)
      .where(and(eq(feeStructures.id, id), eq(feeStructures.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in fee structure');
    throw e;
  }
}

export async function deleteFeeStructure(tenant: TenantContext, id: bigint) {
  try {
    const [deleted] = await db
      .delete(feeStructures)
      .where(and(eq(feeStructures.id, id), eq(feeStructures.tenantId, tenant.id)))
      .returning();
    if (!deleted) throw new HttpError(404, 'Fee structure not found');
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(409, 'Fee structure is assigned and cannot be deleted');
    throw e;
  }
}

export async function addFeeStructureItem(tenant: TenantContext, feeStructureId: bigint, data: FeeStructureItemInput) {
  await assertFeeStructureInTenant(tenant.id, feeStructureId);
  await assertFeeTypeInTenant(tenant.id, data.feeTypeId);
  const [row] = await db
    .insert(feeStructureItems)
    .values({
      tenantId: tenant.id,
      feeStructureId,
      feeTypeId: data.feeTypeId,
      amount: data.amount.toFixed(2),
      isOptional: data.isOptional,
      dueOn: data.dueOn ?? null,
    })
    .returning();
  return toRow(row);
}

export async function updateFeeStructureItem(
  tenant: TenantContext,
  feeStructureId: bigint,
  itemId: bigint,
  data: UpdateFeeStructureItemInput,
) {
  if (data.feeTypeId !== undefined) await assertFeeTypeInTenant(tenant.id, data.feeTypeId);
  const patch: Partial<typeof feeStructureItems.$inferInsert> = {};
  if (data.feeTypeId !== undefined) patch.feeTypeId = data.feeTypeId;
  if (data.amount !== undefined) patch.amount = data.amount.toFixed(2);
  if (data.isOptional !== undefined) patch.isOptional = data.isOptional;
  if (data.dueOn !== undefined) patch.dueOn = data.dueOn;

  const [updated] = await db
    .update(feeStructureItems)
    .set(patch)
    .where(
      and(
        eq(feeStructureItems.id, itemId),
        eq(feeStructureItems.feeStructureId, feeStructureId),
        eq(feeStructureItems.tenantId, tenant.id),
      ),
    )
    .returning();
  if (!updated) throw new HttpError(404, 'Fee structure item not found');
  return toRow(updated);
}

export async function deleteFeeStructureItem(tenant: TenantContext, feeStructureId: bigint, itemId: bigint) {
  const [deleted] = await db
    .delete(feeStructureItems)
    .where(
      and(
        eq(feeStructureItems.id, itemId),
        eq(feeStructureItems.feeStructureId, feeStructureId),
        eq(feeStructureItems.tenantId, tenant.id),
      ),
    )
    .returning();
  if (!deleted) throw new HttpError(404, 'Fee structure item not found');
}

export async function addFeeInstallment(tenant: TenantContext, feeStructureId: bigint, data: FeeInstallmentInput) {
  await assertFeeStructureInTenant(tenant.id, feeStructureId);
  const [row] = await db
    .insert(feeInstallments)
    .values({
      tenantId: tenant.id,
      feeStructureId,
      name: data.name,
      sequence: data.sequence,
      dueOn: data.dueOn,
      percentOfTotal: data.percentOfTotal.toFixed(2),
    })
    .returning();
  return toRow(row);
}

export async function updateFeeInstallment(
  tenant: TenantContext,
  feeStructureId: bigint,
  installmentId: bigint,
  data: UpdateFeeInstallmentInput,
) {
  const patch: Partial<typeof feeInstallments.$inferInsert> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.sequence !== undefined) patch.sequence = data.sequence;
  if (data.dueOn !== undefined) patch.dueOn = data.dueOn;
  if (data.percentOfTotal !== undefined) patch.percentOfTotal = data.percentOfTotal.toFixed(2);

  const [updated] = await db
    .update(feeInstallments)
    .set(patch)
    .where(
      and(
        eq(feeInstallments.id, installmentId),
        eq(feeInstallments.feeStructureId, feeStructureId),
        eq(feeInstallments.tenantId, tenant.id),
      ),
    )
    .returning();
  if (!updated) throw new HttpError(404, 'Fee installment not found');
  return toRow(updated);
}

export async function deleteFeeInstallment(tenant: TenantContext, feeStructureId: bigint, installmentId: bigint) {
  const [deleted] = await db
    .delete(feeInstallments)
    .where(
      and(
        eq(feeInstallments.id, installmentId),
        eq(feeInstallments.feeStructureId, feeStructureId),
        eq(feeInstallments.tenantId, tenant.id),
      ),
    )
    .returning();
  if (!deleted) throw new HttpError(404, 'Fee installment not found');
}

// ================================================================ FEE ASSIGNMENTS
export async function listFeeAssignments(tenant: TenantContext, q: ListFeeAssignmentsInput) {
  // fee_assignments keys only by enrollment_id; fail closed until enrollments table exists
  if (isRowScopedFor(tenant, 'finance.view')) {
    return { rows: [], meta: pageMeta(q.page, q.limit, 0) };
  }

  const conditions = [eq(feeAssignments.tenantId, tenant.id)];
  if (q.enrollmentId !== undefined) conditions.push(eq(feeAssignments.enrollmentId, q.enrollmentId));
  if (q.feeStructureId !== undefined) conditions.push(eq(feeAssignments.feeStructureId, q.feeStructureId));
  if (q.status !== undefined) conditions.push(eq(feeAssignments.status, q.status));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(feeAssignments).where(where);
  const rows = await db
    .select()
    .from(feeAssignments)
    .where(where)
    .orderBy(desc(feeAssignments.createdAt), asc(feeAssignments.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getFeeAssignment(tenant: TenantContext, id: bigint) {
  if (isRowScopedFor(tenant, 'finance.view')) {
    throw new HttpError(404, 'Fee assignment not found');
  }

  const [row] = await db
    .select()
    .from(feeAssignments)
    .where(and(eq(feeAssignments.id, id), eq(feeAssignments.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Fee assignment not found');
  return toRow(row);
}

export async function createFeeAssignment(tenant: TenantContext, data: CreateFeeAssignmentInput) {
  await assertFeeStructureInTenant(tenant.id, data.feeStructureId);
  const [row] = await db
    .insert(feeAssignments)
    .values({
      tenantId: tenant.id,
      enrollmentId: data.enrollmentId,
      feeStructureId: data.feeStructureId,
      assignedOn: data.assignedOn,
      discountPercent: data.discountPercent.toFixed(2),
      status: data.status,
    })
    .returning();
  return toRow(row);
}

export async function updateFeeAssignment(tenant: TenantContext, id: bigint, data: UpdateFeeAssignmentInput) {
  const patch: Partial<typeof feeAssignments.$inferInsert> = {};
  if (data.assignedOn !== undefined) patch.assignedOn = data.assignedOn;
  if (data.discountPercent !== undefined) patch.discountPercent = data.discountPercent.toFixed(2);
  if (data.status !== undefined) patch.status = data.status;

  const [updated] = await db
    .update(feeAssignments)
    .set(patch)
    .where(and(eq(feeAssignments.id, id), eq(feeAssignments.tenantId, tenant.id)))
    .returning();
  if (!updated) throw new HttpError(404, 'Fee assignment not found');
  return toRow(updated);
}

export async function deleteFeeAssignment(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(feeAssignments)
    .where(and(eq(feeAssignments.id, id), eq(feeAssignments.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Fee assignment not found');
}

// ================================================================ INVOICES & LINES
export async function listInvoices(tenant: TenantContext, user: AuthUser, q: ListInvoicesInput) {
  const scope = await resolveStudentScope(tenant, user.id, 'finance.view');
  const scopeCond = studentScopeCondition(invoices.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const conditions = [eq(invoices.tenantId, tenant.id)];
  if (scopeCond) conditions.push(scopeCond);
  if (q.studentId !== undefined) conditions.push(eq(invoices.studentId, q.studentId));
  if (q.enrollmentId !== undefined) conditions.push(eq(invoices.enrollmentId, q.enrollmentId));
  if (q.academicYearId !== undefined) conditions.push(eq(invoices.academicYearId, q.academicYearId));
  if (q.status !== undefined) conditions.push(eq(invoices.status, q.status));
  if (q.q) conditions.push(ilike(invoices.number, `%${q.q}%`));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(invoices).where(where);
  const rows = await db
    .select()
    .from(invoices)
    .where(where)
    .orderBy(desc(invoices.issuedOn), desc(invoices.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getInvoice(tenant: TenantContext, user: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, user.id, 'finance.view');
  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenant.id)))
    .limit(1);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  assertStudentReadable(scope, inv.studentId, 'Invoice not found');

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(and(eq(invoiceLines.tenantId, tenant.id), eq(invoiceLines.invoiceId, id)))
    .orderBy(asc(invoiceLines.id));

  const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0).toFixed(2);
  return { ...toRow(inv), lines: lines.map(toRow), totalAmount };
}

export async function createInvoice(tenant: TenantContext, data: CreateInvoiceInput) {
  await assertStudentInTenant(tenant.id, data.studentId);
  if (data.installmentId != null) {
    const [inst] = await db
      .select({ id: feeInstallments.id })
      .from(feeInstallments)
      .where(and(eq(feeInstallments.id, data.installmentId), eq(feeInstallments.tenantId, tenant.id)))
      .limit(1);
    if (!inst) throw new HttpError(400, 'Installment not found in this school');
  }
  for (const line of data.lines) {
    if (line.feeTypeId != null) await assertFeeTypeInTenant(tenant.id, line.feeTypeId);
  }

  try {
    return await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(invoices)
        .values({
          tenantId: tenant.id,
          number: data.number ?? genCode('INV'),
          studentId: data.studentId,
          enrollmentId: data.enrollmentId ?? null,
          academicYearId: data.academicYearId,
          installmentId: data.installmentId ?? null,
          issuedOn: data.issuedOn,
          dueOn: data.dueOn,
          status: data.status,
        })
        .returning();

      const lines = await tx
        .insert(invoiceLines)
        .values(
          data.lines.map((l) => ({
            tenantId: tenant.id,
            invoiceId: inv.id,
            lineType: l.lineType,
            feeTypeId: l.feeTypeId ?? null,
            quantity: l.quantity.toFixed(2),
            unitAmount: l.unitAmount.toFixed(2),
            discountAmount: l.discountAmount.toFixed(2),
            taxAmount: l.taxAmount.toFixed(2),
            lineTotal: computeLineTotal(l),
          })),
        )
        .returning();

      const totalAmount = lines.reduce((sum, l) => sum + Number(l.lineTotal), 0).toFixed(2);
      return { ...toRow(inv), lines: lines.map(toRow), totalAmount };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'An invoice with this number already exists');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in invoice');
    throw e;
  }
}

export async function generateInvoiceFromStructure(tenant: TenantContext, data: GenerateInvoiceFromStructureInput) {
  await assertStudentInTenant(tenant.id, data.studentId);
  await assertFeeStructureInTenant(tenant.id, data.feeStructureId);

  const items = await db
    .select()
    .from(feeStructureItems)
    .where(and(eq(feeStructureItems.tenantId, tenant.id), eq(feeStructureItems.feeStructureId, data.feeStructureId)))
    .orderBy(asc(feeStructureItems.id));

  if (items.length === 0) {
    throw new HttpError(400, 'Fee structure has no items to invoice');
  }

  let ratio = 1;
  if (data.installmentId != null) {
    const [inst] = await db
      .select()
      .from(feeInstallments)
      .where(
        and(
          eq(feeInstallments.id, data.installmentId),
          eq(feeInstallments.feeStructureId, data.feeStructureId),
          eq(feeInstallments.tenantId, tenant.id),
        ),
      )
      .limit(1);
    if (!inst) throw new HttpError(400, 'Installment does not belong to this fee structure');
    ratio = Number(inst.percentOfTotal) / 100;
  }

  const lines: InvoiceLineInput[] = items
    .filter((i) => !i.isOptional)
    .map((item) => {
      const unit = Number((Number(item.amount) * ratio).toFixed(2));
      const discount = Number(((unit * data.discountPercent) / 100).toFixed(2));
      return {
        lineType: 'fee' as const,
        feeTypeId: item.feeTypeId,
        quantity: 1,
        unitAmount: unit,
        discountAmount: discount,
        taxAmount: 0,
      };
    });

  if (lines.length === 0) {
    throw new HttpError(400, 'Fee structure has no mandatory items to invoice');
  }

  return createInvoice(tenant, {
    number: data.number,
    studentId: data.studentId,
    enrollmentId: data.enrollmentId,
    academicYearId: data.academicYearId,
    installmentId: data.installmentId,
    issuedOn: data.issuedOn,
    dueOn: data.dueOn,
    status: data.status,
    lines,
  });
}

export async function updateInvoice(tenant: TenantContext, id: bigint, data: UpdateInvoiceInput) {
  const [existing] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Invoice not found');

  const issuedOn = data.issuedOn ?? existing.issuedOn;
  const dueOn = data.dueOn ?? existing.dueOn;
  if (dueOn < issuedOn) throw new HttpError(400, 'dueOn must be on or after issuedOn');

  const patch: Partial<typeof invoices.$inferInsert> = {};
  if (data.issuedOn !== undefined) patch.issuedOn = data.issuedOn;
  if (data.dueOn !== undefined) patch.dueOn = data.dueOn;
  if (data.status !== undefined) patch.status = data.status;

  const [updated] = await db
    .update(invoices)
    .set(patch)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function addInvoiceLine(tenant: TenantContext, invoiceId: bigint, data: InvoiceLineInput) {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenant.id)))
    .limit(1);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'void' || inv.status === 'paid') {
    throw new HttpError(409, `Cannot add lines to a ${inv.status} invoice`);
  }
  if (data.feeTypeId != null) await assertFeeTypeInTenant(tenant.id, data.feeTypeId);

  const [line] = await db
    .insert(invoiceLines)
    .values({
      tenantId: tenant.id,
      invoiceId,
      lineType: data.lineType,
      feeTypeId: data.feeTypeId ?? null,
      quantity: data.quantity.toFixed(2),
      unitAmount: data.unitAmount.toFixed(2),
      discountAmount: data.discountAmount.toFixed(2),
      taxAmount: data.taxAmount.toFixed(2),
      lineTotal: computeLineTotal(data),
    })
    .returning();
  return toRow(line);
}

export async function deleteInvoiceLine(tenant: TenantContext, invoiceId: bigint, lineId: bigint) {
  const [inv] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenant.id)))
    .limit(1);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'void' || inv.status === 'paid') {
    throw new HttpError(409, `Cannot remove lines from a ${inv.status} invoice`);
  }

  const [deleted] = await db
    .delete(invoiceLines)
    .where(
      and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId), eq(invoiceLines.tenantId, tenant.id)),
    )
    .returning();
  if (!deleted) throw new HttpError(404, 'Invoice line not found');
}

// ================================================================ PAYMENTS (Idempotent)
export async function listPayments(tenant: TenantContext, user: AuthUser, q: ListPaymentsInput) {
  const scope = await resolveStudentScope(tenant, user.id, 'finance.view');
  const scopeCond = studentScopeCondition(payments.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const conditions = [eq(payments.tenantId, tenant.id)];
  if (scopeCond) conditions.push(scopeCond);
  if (q.studentId !== undefined) conditions.push(eq(payments.studentId, q.studentId));
  if (q.method !== undefined) conditions.push(eq(payments.method, q.method));
  if (q.status !== undefined) conditions.push(eq(payments.status, q.status));
  if (q.q) conditions.push(ilike(payments.receiptNo, `%${q.q}%`));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(payments).where(where);
  const rows = await db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(payments.receivedAt), desc(payments.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getPayment(tenant: TenantContext, user: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, user.id, 'finance.view');
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, id), eq(payments.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Payment not found');
  assertStudentReadable(scope, row.studentId, 'Payment not found');
  return toRow(row);
}

export async function createPayment(tenant: TenantContext, user: AuthUser, data: CreatePaymentInput) {
  await assertStudentInTenant(tenant.id, data.studentId);

  if (data.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenant.id), eq(payments.idempotencyKey, data.idempotencyKey)))
      .limit(1);
    if (existing) {
      return { row: toRow(existing), replayed: true };
    }
  }

  try {
    const [createdRow] = await db
      .insert(payments)
      .values({
        tenantId: tenant.id,
        receiptNo: data.receiptNo ?? genCode('RCP'),
        studentId: data.studentId,
        amount: data.amount.toFixed(2),
        method: data.method,
        receivedAt: data.receivedAt ?? new Date(),
        receivedBy: user.id,
        status: data.status,
        idempotencyKey: data.idempotencyKey ?? null,
        chequeNo: data.chequeNo ?? null,
        chequeDate: data.chequeDate ?? null,
        chequeStatus: data.chequeStatus ?? null,
      })
      .returning();
    return { row: toRow(createdRow), replayed: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (data.idempotencyKey) {
        const [existing] = await db
          .select()
          .from(payments)
          .where(and(eq(payments.tenantId, tenant.id), eq(payments.idempotencyKey, data.idempotencyKey)))
          .limit(1);
        if (existing) return { row: toRow(existing), replayed: true };
      }
      throw new HttpError(409, 'A payment with this receipt number already exists');
    }
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in payment');
    throw e;
  }
}

export async function updatePayment(tenant: TenantContext, id: bigint, data: UpdatePaymentInput) {
  const patch: Partial<typeof payments.$inferInsert> = {};
  if (data.status !== undefined) patch.status = data.status;
  if (data.chequeNo !== undefined) patch.chequeNo = data.chequeNo;
  if (data.chequeDate !== undefined) patch.chequeDate = data.chequeDate;
  if (data.chequeStatus !== undefined) patch.chequeStatus = data.chequeStatus;

  const [updated] = await db
    .update(payments)
    .set(patch)
    .where(and(eq(payments.id, id), eq(payments.tenantId, tenant.id)))
    .returning();
  if (!updated) throw new HttpError(404, 'Payment not found');
  return toRow(updated);
}
