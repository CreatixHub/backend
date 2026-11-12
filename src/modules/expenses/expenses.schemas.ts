import { z } from 'zod';

export const EXPENSE_APPROVAL_LEVELS = ['none', 'manager', 'admin', 'owner'] as const;
export const EXPENSE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const EXPENSE_STATUSES = ['submitted', 'approved', 'rejected', 'paid'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const money = z.number().min(0).max(9999999999.99);

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// ---------------------------------------------------------------- expense_categories
const expenseCategoryFields = {
  name: text(120),
  parentId: id.nullish(),
  annualBudget: money.nullish(),
  perExpenseLimit: money.nullish(),
  approvalLevel: z.enum(EXPENSE_APPROVAL_LEVELS).default('manager'),
  isActive: z.boolean().default(true),
};

export const listExpenseCategoriesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    parentId: id.optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createExpenseCategorySchema = z.object(expenseCategoryFields).strict();
export const updateExpenseCategorySchema = z
  .object(expenseCategoryFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- expenses
const expenseFields = {
  expenseNo: text(40).optional(),
  categoryId: id,
  vendorId: id.nullish(),
  branchId: id.nullish(),
  staffId: id.nullish(),
  priority: z.enum(EXPENSE_PRIORITIES).default('normal'),
  amount: z.number().positive().max(9999999999.99),
  taxAmount: money.default(0),
  expenseDate: isoDate,
  description: text(1000),
  paymentMethod: text(40).nullish(),
  receiptFileId: id.nullish(),
};

export const listExpensesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    categoryId: id.optional(),
    staffId: id.optional(),
    branchId: id.optional(),
    status: z.enum(EXPENSE_STATUSES).optional(),
    priority: z.enum(EXPENSE_PRIORITIES).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createExpenseSchema = z.object(expenseFields).strict();

export const updateExpenseSchema = z
  .object(expenseFields)
  .omit({ expenseNo: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const decideExpenseSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

export const markExpensePaidSchema = z
  .object({
    paymentMethod: text(40).optional(),
    paidAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  })
  .strict();

export type ListExpenseCategoriesInput = z.infer<typeof listExpenseCategoriesSchema>;
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

export type ListExpensesInput = z.infer<typeof listExpensesSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type DecideExpenseInput = z.infer<typeof decideExpenseSchema>;
export type MarkExpensePaidInput = z.infer<typeof markExpensePaidSchema>;
