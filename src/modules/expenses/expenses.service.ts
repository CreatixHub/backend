import crypto from 'node:crypto';
import { and, asc, count, desc, eq, gte, ilike, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../db';
import { expenseCategories, expenses, staff } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateExpenseCategoryInput,
  CreateExpenseInput,
  DecideExpenseInput,
  ListExpenseCategoriesInput,
  ListExpensesInput,
  MarkExpensePaidInput,
  UpdateExpenseCategoryInput,
  UpdateExpenseInput,
} from './expenses.schemas';

const toRow = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const fixed2 = (n: number | null | undefined): string | null | undefined => (n == null ? n : n.toFixed(2));
const genNo = () => `EXP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function assertCategoryInTenant(tenantId: bigint, categoryId: bigint) {
  const [cat] = await db
    .select()
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, categoryId), eq(expenseCategories.tenantId, tenantId)))
    .limit(1);
  if (!cat) throw new HttpError(400, 'Expense category not found in this school');
  return cat;
}

// ================================================================ EXPENSE CATEGORIES
export async function listExpenseCategories(tenant: TenantContext, q: ListExpenseCategoriesInput) {
  const conditions = [eq(expenseCategories.tenantId, tenant.id)];
  if (q.parentId !== undefined) conditions.push(eq(expenseCategories.parentId, q.parentId));
  if (q.isActive !== undefined) conditions.push(eq(expenseCategories.isActive, q.isActive));
  if (q.q) conditions.push(ilike(expenseCategories.name, `%${q.q}%`));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(expenseCategories).where(where);
  const rows = await db
    .select()
    .from(expenseCategories)
    .where(where)
    .orderBy(asc(expenseCategories.name), asc(expenseCategories.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getExpenseCategory(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(expenseCategories)
    .where(and(eq(expenseCategories.id, id), eq(expenseCategories.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Expense category not found');
  return toRow(row);
}

export async function createExpenseCategory(tenant: TenantContext, data: CreateExpenseCategoryInput) {
  if (data.parentId != null) await assertCategoryInTenant(tenant.id, data.parentId);
  try {
    const [row] = await db
      .insert(expenseCategories)
      .values({
        tenantId: tenant.id,
        name: data.name,
        parentId: data.parentId ?? null,
        annualBudget: fixed2(data.annualBudget) ?? null,
        perExpenseLimit: fixed2(data.perExpenseLimit) ?? null,
        approvalLevel: data.approvalLevel,
        isActive: data.isActive,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'An expense category with this name already exists');
    throw e;
  }
}

export async function updateExpenseCategory(tenant: TenantContext, id: bigint, data: UpdateExpenseCategoryInput) {
  await assertCategoryInTenant(tenant.id, id);
  if (data.parentId != null) {
    if (data.parentId === id) throw new HttpError(400, 'Category cannot be its own parent');
    await assertCategoryInTenant(tenant.id, data.parentId);
  }

  const patch: Partial<typeof expenseCategories.$inferInsert> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.parentId !== undefined) patch.parentId = data.parentId;
  if (data.annualBudget !== undefined) patch.annualBudget = fixed2(data.annualBudget);
  if (data.perExpenseLimit !== undefined) patch.perExpenseLimit = fixed2(data.perExpenseLimit);
  if (data.approvalLevel !== undefined) patch.approvalLevel = data.approvalLevel;
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  try {
    const [updated] = await db
      .update(expenseCategories)
      .set(patch)
      .where(and(eq(expenseCategories.id, id), eq(expenseCategories.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'An expense category with this name already exists');
    throw e;
  }
}

export async function deleteExpenseCategory(tenant: TenantContext, id: bigint) {
  try {
    const [deleted] = await db
      .delete(expenseCategories)
      .where(and(eq(expenseCategories.id, id), eq(expenseCategories.tenantId, tenant.id)))
      .returning();
    if (!deleted) throw new HttpError(404, 'Expense category not found');
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(409, 'Expense category is in use and cannot be deleted');
    throw e;
  }
}

// ================================================================ EXPENSES
export async function listExpenses(tenant: TenantContext, q: ListExpensesInput) {
  const conditions = [eq(expenses.tenantId, tenant.id)];
  if (q.categoryId !== undefined) conditions.push(eq(expenses.categoryId, q.categoryId));
  if (q.staffId !== undefined) conditions.push(eq(expenses.staffId, q.staffId));
  if (q.branchId !== undefined) conditions.push(eq(expenses.branchId, q.branchId));
  if (q.status !== undefined) conditions.push(eq(expenses.status, q.status));
  if (q.priority !== undefined) conditions.push(eq(expenses.priority, q.priority));
  if (q.dateFrom !== undefined) conditions.push(gte(expenses.expenseDate, q.dateFrom));
  if (q.dateTo !== undefined) conditions.push(lte(expenses.expenseDate, q.dateTo));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(expenses.expenseNo, pattern), ilike(expenses.description, pattern));
    if (searchCond) conditions.push(searchCond);
  }

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(expenses).where(where);
  const rows = await db
    .select()
    .from(expenses)
    .where(where)
    .orderBy(desc(expenses.expenseDate), desc(expenses.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getExpense(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Expense not found');
  return toRow(row);
}

export async function createExpense(tenant: TenantContext, data: CreateExpenseInput) {
  const cat = await assertCategoryInTenant(tenant.id, data.categoryId);
  if (!cat.isActive) throw new HttpError(400, 'Expense category is inactive');
  if (cat.perExpenseLimit != null && data.amount + data.taxAmount > Number(cat.perExpenseLimit)) {
    throw new HttpError(400, `Expense exceeds category per-expense limit of ${cat.perExpenseLimit}`);
  }
  if (data.staffId != null) {
    const [st] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, data.staffId), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
      .limit(1);
    if (!st) throw new HttpError(400, 'Staff member not found in this school');
  }

  try {
    const [row] = await db
      .insert(expenses)
      .values({
        tenantId: tenant.id,
        expenseNo: data.expenseNo ?? genNo(),
        categoryId: data.categoryId,
        vendorId: data.vendorId ?? null,
        branchId: data.branchId ?? null,
        staffId: data.staffId ?? null,
        priority: data.priority,
        amount: data.amount.toFixed(2),
        taxAmount: data.taxAmount.toFixed(2),
        expenseDate: data.expenseDate,
        description: data.description,
        paymentMethod: data.paymentMethod ?? null,
        receiptFileId: data.receiptFileId ?? null,
        status: 'submitted',
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'An expense with this expenseNo already exists');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in expense');
    throw e;
  }
}

export async function updateExpense(tenant: TenantContext, id: bigint, data: UpdateExpenseInput) {
  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Expense not found');
  if (existing.status !== 'submitted') {
    throw new HttpError(409, 'Only submitted expenses can be edited');
  }

  const categoryId = data.categoryId ?? existing.categoryId;
  const cat = await assertCategoryInTenant(tenant.id, categoryId);
  const nextAmount = data.amount ?? Number(existing.amount);
  const nextTax = data.taxAmount ?? Number(existing.taxAmount);
  if (cat.perExpenseLimit != null && nextAmount + nextTax > Number(cat.perExpenseLimit)) {
    throw new HttpError(400, `Expense exceeds category per-expense limit of ${cat.perExpenseLimit}`);
  }

  if (data.staffId != null) {
    const [st] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, data.staffId), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
      .limit(1);
    if (!st) throw new HttpError(400, 'Staff member not found in this school');
  }

  const patch: Partial<typeof expenses.$inferInsert> = {};
  if (data.categoryId !== undefined) patch.categoryId = data.categoryId;
  if (data.vendorId !== undefined) patch.vendorId = data.vendorId;
  if (data.branchId !== undefined) patch.branchId = data.branchId;
  if (data.staffId !== undefined) patch.staffId = data.staffId;
  if (data.priority !== undefined) patch.priority = data.priority;
  if (data.amount !== undefined) patch.amount = data.amount.toFixed(2);
  if (data.taxAmount !== undefined) patch.taxAmount = data.taxAmount.toFixed(2);
  if (data.expenseDate !== undefined) patch.expenseDate = data.expenseDate;
  if (data.description !== undefined) patch.description = data.description;
  if (data.paymentMethod !== undefined) patch.paymentMethod = data.paymentMethod;
  if (data.receiptFileId !== undefined) patch.receiptFileId = data.receiptFileId;

  const [updated] = await db
    .update(expenses)
    .set(patch)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function decideExpense(tenant: TenantContext, user: AuthUser, id: bigint, data: DecideExpenseInput) {
  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Expense not found');
  if (existing.status !== 'submitted') {
    throw new HttpError(409, `Expense is already ${existing.status}`);
  }

  const [updated] = await db
    .update(expenses)
    .set({
      status: data.decision,
      approvedBy: user.id,
      approvedAt: new Date(),
    })
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function markExpensePaid(tenant: TenantContext, id: bigint, data: MarkExpensePaidInput) {
  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Expense not found');
  if (existing.status !== 'approved') {
    throw new HttpError(409, 'Only approved expenses can be marked paid');
  }

  const [updated] = await db
    .update(expenses)
    .set({
      status: 'paid',
      paidAt: data.paidAt ?? new Date(),
      ...(data.paymentMethod !== undefined ? { paymentMethod: data.paymentMethod } : {}),
    })
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function deleteExpense(tenant: TenantContext, id: bigint) {
  const [existing] = await db
    .select({ id: expenses.id, status: expenses.status })
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Expense not found');
  if (existing.status !== 'submitted' && existing.status !== 'rejected') {
    throw new HttpError(409, `Cannot delete an ${existing.status} expense`);
  }

  await db.delete(expenses).where(and(eq(expenses.id, id), eq(expenses.tenantId, tenant.id)));
}
