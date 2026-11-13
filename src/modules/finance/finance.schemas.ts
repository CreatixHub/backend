import { z } from 'zod';

export const FEE_FREQUENCIES = ['one_time', 'monthly', 'quarterly', 'annual'] as const;
export const FEE_ASSIGNMENT_STATUSES = ['active', 'cancelled'] as const;
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void'] as const;
export const INVOICE_LINE_TYPES = ['fee', 'discount', 'fine', 'tax'] as const;
export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'online', 'upi'] as const;
export const PAYMENT_STATUSES = ['cleared', 'pending', 'bounced', 'reversed'] as const;

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

const isoDateTime = z.string().datetime({ offset: true }).transform((v) => new Date(v));

// ---------------------------------------------------------------- fee_groups
const feeGroupFields = {
  name: text(100),
  code: text(30).nullish(),
  category: text(60),
  displayOrder: z.number().int().min(0).max(32767).default(0),
  isActive: z.boolean().default(true),
};

export const listFeeGroupsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createFeeGroupSchema = z.object(feeGroupFields).strict();
export const updateFeeGroupSchema = z.object(feeGroupFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- fee_types
const feeTypeFields = {
  feeGroupId: id.nullish(),
  code: text(30).transform((s) => s.toUpperCase()),
  name: text(120),
  category: text(60),
  frequency: z.enum(FEE_FREQUENCIES),
  isRefundable: z.boolean().default(false),
  isMandatory: z.boolean().default(true),
  lateFeeApplicable: z.boolean().default(false),
  defaultAmount: money.nullish(),
  status: text(30).default('active'),
};

export const listFeeTypesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    feeGroupId: id.optional(),
    frequency: z.enum(FEE_FREQUENCIES).optional(),
    status: text(30).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createFeeTypeSchema = z.object(feeTypeFields).strict();
export const updateFeeTypeSchema = z.object(feeTypeFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- fee_structures + items + installments
export const feeStructureItemInputSchema = z
  .object({
    feeTypeId: id,
    amount: money,
    isOptional: z.boolean().default(false),
    dueOn: isoDate.nullish(),
  })
  .strict();

export const updateFeeStructureItemSchema = feeStructureItemInputSchema
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const feeInstallmentInputSchema = z
  .object({
    name: text(100),
    sequence: z.number().int().min(1).max(32767),
    dueOn: isoDate,
    percentOfTotal: z.number().positive().max(100),
  })
  .strict();

export const updateFeeInstallmentSchema = feeInstallmentInputSchema
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

const feeStructureBaseFields = {
  academicYearId: id,
  classId: id,
  name: text(120).nullish(),
  code: text(40).nullish(),
  description: text(500).nullish(),
  frequency: text(40),
  effectiveFrom: isoDate.nullish(),
  status: text(30).default('active'),
};

export const listFeeStructuresSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    academicYearId: id.optional(),
    classId: id.optional(),
    status: text(30).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createFeeStructureSchema = z
  .object({
    ...feeStructureBaseFields,
    items: z.array(feeStructureItemInputSchema).max(50).optional(),
    installments: z.array(feeInstallmentInputSchema).max(24).optional(),
  })
  .strict();

export const updateFeeStructureSchema = z
  .object(feeStructureBaseFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- fee_assignments
const feeAssignmentFields = {
  enrollmentId: id,
  feeStructureId: id,
  assignedOn: isoDate,
  discountPercent: z.number().min(0).max(100).default(0),
  status: z.enum(FEE_ASSIGNMENT_STATUSES).default('active'),
};

export const listFeeAssignmentsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    enrollmentId: id.optional(),
    feeStructureId: id.optional(),
    status: z.enum(FEE_ASSIGNMENT_STATUSES).optional(),
  })
  .strict();

export const createFeeAssignmentSchema = z.object(feeAssignmentFields).strict();
export const updateFeeAssignmentSchema = z
  .object({
    assignedOn: isoDate.optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    status: z.enum(FEE_ASSIGNMENT_STATUSES).optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- invoices & invoice_lines
export const invoiceLineInputSchema = z
  .object({
    lineType: z.enum(INVOICE_LINE_TYPES),
    feeTypeId: id.nullish(),
    quantity: z.number().positive().max(999999).default(1),
    unitAmount: money,
    discountAmount: money.default(0),
    taxAmount: money.default(0),
  })
  .strict();

export const listInvoicesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    studentId: id.optional(),
    enrollmentId: id.optional(),
    academicYearId: id.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createInvoiceSchema = z
  .object({
    number: text(40).optional(),
    studentId: id,
    enrollmentId: id.nullish(),
    academicYearId: id,
    installmentId: id.nullish(),
    issuedOn: isoDate,
    dueOn: isoDate,
    status: z.enum(INVOICE_STATUSES).default('issued'),
    lines: z.array(invoiceLineInputSchema).min(1).max(100),
  })
  .strict()
  .refine((v) => v.dueOn >= v.issuedOn, {
    message: 'dueOn must be on or after issuedOn',
    path: ['dueOn'],
  });

export const generateInvoiceFromStructureSchema = z
  .object({
    number: text(40).optional(),
    studentId: id,
    enrollmentId: id.nullish(),
    academicYearId: id,
    feeStructureId: id,
    installmentId: id.nullish(),
    issuedOn: isoDate,
    dueOn: isoDate,
    discountPercent: z.number().min(0).max(100).default(0),
    status: z.enum(['draft', 'issued']).default('issued'),
  })
  .strict()
  .refine((v) => v.dueOn >= v.issuedOn, {
    message: 'dueOn must be on or after issuedOn',
    path: ['dueOn'],
  });

export const updateInvoiceSchema = z
  .object({
    issuedOn: isoDate.optional(),
    dueOn: isoDate.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- payments
export const listPaymentsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    studentId: id.optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createPaymentSchema = z
  .object({
    receiptNo: text(40).optional(),
    studentId: id,
    amount: z.number().positive().max(9999999999.99),
    method: z.enum(PAYMENT_METHODS),
    receivedAt: isoDateTime.optional(),
    status: z.enum(PAYMENT_STATUSES).default('cleared'),
    idempotencyKey: text(120).nullish(),
    chequeNo: text(40).nullish(),
    chequeDate: isoDate.nullish(),
    chequeStatus: text(40).nullish(),
  })
  .strict();

export const updatePaymentSchema = z
  .object({
    status: z.enum(PAYMENT_STATUSES).optional(),
    chequeNo: text(40).nullish(),
    chequeDate: isoDate.nullish(),
    chequeStatus: text(40).nullish(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export type ListFeeGroupsInput = z.infer<typeof listFeeGroupsSchema>;
export type CreateFeeGroupInput = z.infer<typeof createFeeGroupSchema>;
export type UpdateFeeGroupInput = z.infer<typeof updateFeeGroupSchema>;

export type ListFeeTypesInput = z.infer<typeof listFeeTypesSchema>;
export type CreateFeeTypeInput = z.infer<typeof createFeeTypeSchema>;
export type UpdateFeeTypeInput = z.infer<typeof updateFeeTypeSchema>;

export type ListFeeStructuresInput = z.infer<typeof listFeeStructuresSchema>;
export type CreateFeeStructureInput = z.infer<typeof createFeeStructureSchema>;
export type UpdateFeeStructureInput = z.infer<typeof updateFeeStructureSchema>;
export type FeeStructureItemInput = z.infer<typeof feeStructureItemInputSchema>;
export type UpdateFeeStructureItemInput = z.infer<typeof updateFeeStructureItemSchema>;
export type FeeInstallmentInput = z.infer<typeof feeInstallmentInputSchema>;
export type UpdateFeeInstallmentInput = z.infer<typeof updateFeeInstallmentSchema>;

export type ListFeeAssignmentsInput = z.infer<typeof listFeeAssignmentsSchema>;
export type CreateFeeAssignmentInput = z.infer<typeof createFeeAssignmentSchema>;
export type UpdateFeeAssignmentInput = z.infer<typeof updateFeeAssignmentSchema>;

export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type GenerateInvoiceFromStructureInput = z.infer<typeof generateInvoiceFromStructureSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

export type ListPaymentsInput = z.infer<typeof listPaymentsSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
