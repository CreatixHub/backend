import { z } from 'zod';

export const DEPRECIATION_METHODS = ['straight_line', 'declining_balance', 'none'] as const;
export const ASSET_STATUSES = ['in_use', 'in_store', 'under_repair', 'retired', 'disposed'] as const;
// "disposed" is only reachable through the dispose endpoint
export const SETTABLE_ASSET_STATUSES = ['in_use', 'in_store', 'under_repair', 'retired'] as const;
export const CONDITIONS = ['new', 'good', 'fair', 'poor'] as const;
export const MAINTENANCE_TYPES = ['scheduled', 'repair', 'inspection'] as const;
export const MAINTENANCE_STATUSES = ['reported', 'in_progress', 'completed', 'cancelled'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const money = z.number().min(0).max(1_000_000_000);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const paging = (defaultLimit = 20) => ({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
});
// YYYY-MM-DD, and a REAL date (rejects 2026-02-31)
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// ---------------------------------------------------------------- categories
const categoryFields = {
  name: text(120),
  parentId: id.nullish(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(), // defaults to none
  usefulLifeYears: z.number().int().min(1).max(100).nullish(),
};
export const createCategorySchema = z.object(categoryFields).strict();
export const updateCategorySchema = z.object(categoryFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- assets
const assetFields = {
  assetTag: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'Tag: up to 30 letters, digits, - or _')
    .optional(), // generated as AST-0001 when omitted
  name: text(200),
  categoryId: id,
  vendorId: id.nullish(),
  branchId: id.nullish(),
  quantity: z.number().int().min(1).max(1_000_000).optional(), // defaults to 1
  serialNo: text(100).nullish(),
  model: text(100).nullish(),
  purchaseDate: isoDate.nullish(),
  purchaseCost: money.nullish(),
  warrantyUntil: isoDate.nullish(),
  salvageValue: money.nullish(),
  locationClassroomId: id.nullish(),
  status: z.enum(SETTABLE_ASSET_STATUSES).optional(), // defaults to in_store
  condition: z.enum(CONDITIONS).optional(), // defaults to good
  notes: text(1000).nullish(),
};

export const listAssetsSchema = z
  .object({
    ...paging(),
    q: z.string().trim().max(100).optional(), // tag, name, serial number
    categoryId: id.optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    condition: z.enum(CONDITIONS).optional(),
    branchId: id.optional(),
    classroomId: id.optional(),
    warrantyExpiringWithinDays: z.coerce.number().int().min(1).max(730).optional(),
  })
  .strict();
export const createAssetSchema = z.object(assetFields).strict();
// the tag never changes once assigned
export const updateAssetSchema = z
  .object(assetFields)
  .omit({ assetTag: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');
export const disposeAssetSchema = z
  .object({ disposedOn: isoDate.optional(), disposalValue: money.optional(), notes: text(1000).optional() })
  .strict();

// ---------------------------------------------------------------- allocations
export const listAllocationsSchema = z
  .object({
    ...paging(),
    assetId: id.optional(),
    staffId: id.optional(),
    studentId: id.optional(),
    classroomId: id.optional(),
    open: flag.optional(), // true = not yet returned
    overdue: flag.optional(), // true = not returned and past the expected return date
  })
  .strict();
export const createAllocationSchema = z
  .object({
    assetId: id,
    staffId: id.nullish(),
    studentId: id.nullish(),
    classroomId: id.nullish(),
    allocatedOn: isoDate.optional(), // defaults to today
    expectedReturnOn: isoDate.nullish(),
    conditionOut: z.enum(CONDITIONS).optional(), // defaults to the asset's condition
    notes: text(500).nullish(),
  })
  .strict()
  .refine((v) => [v.staffId, v.studentId, v.classroomId].filter((x) => x != null).length === 1, {
    message: 'Send exactly one of staffId, studentId or classroomId',
    path: ['staffId'],
  });
// to move an asset to someone else, return it and allocate again
export const updateAllocationSchema = z
  .object({ expectedReturnOn: isoDate.nullish(), notes: text(500).nullish(), conditionOut: z.enum(CONDITIONS).optional() })
  .strict()
  .refine(nonEmpty, 'Nothing to change');
export const returnAllocationSchema = z
  .object({ returnedOn: isoDate.optional(), conditionIn: z.enum(CONDITIONS), notes: text(500).nullish() })
  .strict();

// ---------------------------------------------------------------- maintenance
const maintenanceFields = {
  assetId: id,
  maintenanceType: z.enum(MAINTENANCE_TYPES),
  description: text(1000).nullish(),
  reportedOn: isoDate.nullish(),
  startedOn: isoDate.nullish(),
  completedOn: isoDate.nullish(),
  cost: money.nullish(),
  labourCost: money.nullish(),
  partsCost: money.nullish(),
  vendorId: id.nullish(),
  status: z.enum(MAINTENANCE_STATUSES).optional(), // defaults to reported
  nextDueOn: isoDate.nullish(),
};

export const listMaintenanceSchema = z
  .object({
    ...paging(),
    assetId: id.optional(),
    status: z.enum(MAINTENANCE_STATUSES).optional(),
    maintenanceType: z.enum(MAINTENANCE_TYPES).optional(),
    dueWithinDays: z.coerce.number().int().min(1).max(365).optional(), // next_due_on is overdue or due soon
  })
  .strict();
export const createMaintenanceSchema = z.object(maintenanceFields).strict();
export const updateMaintenanceSchema = z
  .object(maintenanceFields)
  .omit({ assetId: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListAssetsInput = z.infer<typeof listAssetsSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type DisposeAssetInput = z.infer<typeof disposeAssetSchema>;
export type ListAllocationsInput = z.infer<typeof listAllocationsSchema>;
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;
export type UpdateAllocationInput = z.infer<typeof updateAllocationSchema>;
export type ReturnAllocationInput = z.infer<typeof returnAllocationSchema>;
export type ListMaintenanceInput = z.infer<typeof listMaintenanceSchema>;
export type CreateMaintenanceInput = z.infer<typeof createMaintenanceSchema>;
export type UpdateMaintenanceInput = z.infer<typeof updateMaintenanceSchema>;