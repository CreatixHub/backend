import { and, asc, count, desc, eq, getTableColumns, ilike, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { assetAllocations, assetCategories, assetMaintenance, assets, classrooms, staff } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateAllocationInput,
  CreateAssetInput,
  CreateCategoryInput,
  CreateMaintenanceInput,
  DisposeAssetInput,
  ListAllocationsInput,
  ListAssetsInput,
  ListMaintenanceInput,
  ReturnAllocationInput,
  UpdateAllocationInput,
  UpdateAssetInput,
  UpdateCategoryInput,
  UpdateMaintenanceInput,
} from './assets.schemas';

// RULES (same as the other modules): every query has tenantId = tenant.id.
// vendors / branches / students tables do not exist yet, so vendorId, branchId and studentId are NOT checked.
// Staff and classrooms are checked.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

interface Page {
  rows: unknown[];
  meta: { page: number; limit: number; total: number; pages: number };
}
const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

// dates are compared as YYYY-MM-DD text (UTC)
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const notFound = <T>(row: T | undefined, message: string): T => {
  if (!row) throw new HttpError(404, message);
  return row;
};
const must = <T>(row: T | undefined, message: string): T => {
  if (!row) throw new HttpError(400, message);
  return row;
};
const invalid = (field: string, message: string): never => {
  throw new HttpError(400, 'Validation failed', [{ field, message }]);
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------- finders (tenant-scoped, undefined when missing)
const findCategory = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(assetCategories)
      .where(and(eq(assetCategories.id, id), eq(assetCategories.tenantId, tenantId)))
      .limit(1)
  )[0];

const findAsset = async (tenantId: bigint, id: bigint) =>
  (await db.select().from(assets).where(and(eq(assets.id, id), eq(assets.tenantId, tenantId))).limit(1))[0];

const findAllocation = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(assetAllocations)
      .where(and(eq(assetAllocations.id, id), eq(assetAllocations.tenantId, tenantId)))
      .limit(1)
  )[0];

const findMaintenance = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(assetMaintenance)
      .where(and(eq(assetMaintenance.id, id), eq(assetMaintenance.tenantId, tenantId)))
      .limit(1)
  )[0];

async function assertClassroom(tenantId: bigint, classroomId: bigint) {
  const [row] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(and(eq(classrooms.id, classroomId), eq(classrooms.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Classroom not found in this school');
}

async function assertActiveStaff(tenantId: bigint, staffId: bigint) {
  const [row] = await db
    .select({ id: staff.id, status: staff.status })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Staff member not found in this school');
  if (row.status !== 'active') throw new HttpError(400, 'That staff member is not active');
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const money = (v: number | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : v.toFixed(2);

// ================================================================ CATEGORIES
const CATEGORY_NAME_TAKEN = 'A category with that name already exists';

function checkDepreciation(method: string, years: number | null) {
  if (method !== 'none' && !years) invalid('usefulLifeYears', 'Required when a depreciation method is set');
}

// Walks up from newParentId. If it reaches categoryId the new parent would create a loop.
async function assertNoCategoryLoop(tenantId: bigint, categoryId: bigint, newParentId: bigint) {
  let current: bigint | null = newParentId;
  for (let depth = 0; current !== null && depth < 50; depth++) {
    if (current === categoryId) invalid('parentId', 'A category cannot sit under itself or one of its children');
    const row: { parentId: bigint | null } | undefined = (
      await db
        .select({ parentId: assetCategories.parentId })
        .from(assetCategories)
        .where(and(eq(assetCategories.id, current), eq(assetCategories.tenantId, tenantId)))
        .limit(1)
    )[0];
    current = row?.parentId ?? null;
  }
}

export async function listCategories(tenant: TenantContext): Promise<unknown> {
  const [rows, counts] = await Promise.all([
    db.select().from(assetCategories).where(eq(assetCategories.tenantId, tenant.id)).orderBy(asc(assetCategories.name)),
    db
      .select({ categoryId: assets.categoryId, total: count() })
      .from(assets)
      .where(eq(assets.tenantId, tenant.id))
      .groupBy(assets.categoryId),
  ]);
  const assetCount = new Map(counts.map((c) => [c.categoryId, c.total]));
  return rows.map((r) => ({ ...toRow(r), assetCount: assetCount.get(r.id) ?? 0 }));
}

export async function createCategory(tenant: TenantContext, _actor: AuthUser, input: CreateCategoryInput): Promise<unknown> {
  const method = input.depreciationMethod ?? 'none';
  checkDepreciation(method, input.usefulLifeYears ?? null);
  if (input.parentId) must(await findCategory(tenant.id, input.parentId), 'Parent category not found in this school');
  try {
    const [row] = await db
      .insert(assetCategories)
      .values({
        tenantId: tenant.id,
        name: input.name,
        parentId: input.parentId ?? null,
        depreciationMethod: method,
        usefulLifeYears: input.usefulLifeYears ?? null,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CATEGORY_NAME_TAKEN);
    throw e;
  }
}

export async function updateCategory(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateCategoryInput,
): Promise<unknown> {
  const existing = notFound(await findCategory(tenant.id, id), 'Category not found');
  const method = input.depreciationMethod ?? existing.depreciationMethod;
  const years = input.usefulLifeYears !== undefined ? input.usefulLifeYears : existing.usefulLifeYears;
  checkDepreciation(method, years);
  if (input.parentId) {
    if (input.parentId === id) invalid('parentId', 'A category cannot be its own parent');
    must(await findCategory(tenant.id, input.parentId), 'Parent category not found in this school');
    await assertNoCategoryLoop(tenant.id, id, input.parentId);
  }
  try {
    const [row] = await db
      .update(assetCategories)
      .set({ name: input.name, parentId: input.parentId, depreciationMethod: input.depreciationMethod, usefulLifeYears: input.usefulLifeYears })
      .where(and(eq(assetCategories.id, id), eq(assetCategories.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CATEGORY_NAME_TAKEN);
    throw e;
  }
}

export async function deleteCategory(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findCategory(tenant.id, id), 'Category not found');
  const [[children], [used]] = await Promise.all([
    db
      .select({ total: count() })
      .from(assetCategories)
      .where(and(eq(assetCategories.tenantId, tenant.id), eq(assetCategories.parentId, id))),
    db.select({ total: count() }).from(assets).where(and(eq(assets.tenantId, tenant.id), eq(assets.categoryId, id))),
  ]);
  if (children.total > 0) throw new HttpError(409, 'This category has sub-categories');
  if (used.total > 0) throw new HttpError(409, 'This category has assets');
  await db.delete(assetCategories).where(and(eq(assetCategories.id, id), eq(assetCategories.tenantId, tenant.id)));
}

// ================================================================ ASSETS
interface AssetShape {
  purchaseDate: string | null;
  warrantyUntil: string | null;
  purchaseCost: number | null;
  salvageValue: number | null;
}

function checkAssetShape(s: AssetShape) {
  if (s.purchaseDate && s.warrantyUntil && s.warrantyUntil < s.purchaseDate) {
    invalid('warrantyUntil', 'Cannot be before the purchase date');
  }
  if (s.purchaseCost !== null && s.salvageValue !== null && s.salvageValue > s.purchaseCost) {
    invalid('salvageValue', 'Cannot be more than the purchase cost');
  }
}

async function nextAssetTag(tenantId: bigint): Promise<string> {
  const [r] = await db
    .select({ max: sql<number | null>`max(substring(${assets.assetTag} from 5)::int)` })
    .from(assets)
    .where(and(eq(assets.tenantId, tenantId), sql`${assets.assetTag} ~ '^AST-[0-9]+$'`));
  return `AST-${String(Number(r?.max ?? 0) + 1).padStart(4, '0')}`;
}

// Book value from the category's depreciation settings. null when it cannot be worked out.
function currentValue(
  a: { purchaseCost: string | null; purchaseDate: string | null; salvageValue: string | null; disposedOn: string | null },
  c: { depreciationMethod: string; usefulLifeYears: number | null },
): string | null {
  if (!a.purchaseCost || !a.purchaseDate || c.depreciationMethod === 'none' || !c.usefulLifeYears) return null;
  const cost = Number(a.purchaseCost);
  const salvage = Number(a.salvageValue ?? 0);
  const years = Math.max(0, (Date.parse(a.disposedOn ?? todayStr()) - Date.parse(a.purchaseDate)) / (365.25 * 86_400_000));
  const life = c.usefulLifeYears;
  const value =
    c.depreciationMethod === 'straight_line'
      ? cost - ((cost - salvage) / life) * years
      : cost * Math.pow(1 - Math.min(2 / life, 1), years); // double declining balance
  return Math.max(salvage, value).toFixed(2);
}

export async function listAssets(tenant: TenantContext, q: ListAssetsInput): Promise<Page> {
  const where = and(
    eq(assets.tenantId, tenant.id),
    q.categoryId ? eq(assets.categoryId, q.categoryId) : undefined,
    q.status ? eq(assets.status, q.status) : undefined,
    q.condition ? eq(assets.condition, q.condition) : undefined,
    q.branchId ? eq(assets.branchId, q.branchId) : undefined,
    q.classroomId ? eq(assets.locationClassroomId, q.classroomId) : undefined,
    q.q ? or(ilike(assets.assetTag, `%${q.q}%`), ilike(assets.name, `%${q.q}%`), ilike(assets.serialNo, `%${q.q}%`)) : undefined,
    q.warrantyExpiringWithinDays
      ? and(
          isNotNull(assets.warrantyUntil),
          lte(assets.warrantyUntil, daysFromToday(q.warrantyExpiringWithinDays)),
          notInArray(assets.status, ['retired', 'disposed']),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(assets), categoryName: assetCategories.name })
      .from(assets)
      .innerJoin(assetCategories, eq(assets.categoryId, assetCategories.id))
      .where(where)
      .orderBy(asc(assets.assetTag))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(assets).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

// One asset with its category, who has it now, its book value and the latest maintenance records.
export async function getAsset(tenant: TenantContext, id: bigint): Promise<unknown> {
  const asset = notFound(await findAsset(tenant.id, id), 'Asset not found');
  const [category, [allocation], maintenance] = await Promise.all([
    findCategory(tenant.id, asset.categoryId),
    db
      .select()
      .from(assetAllocations)
      .where(and(eq(assetAllocations.tenantId, tenant.id), eq(assetAllocations.assetId, id), isNull(assetAllocations.returnedOn)))
      .limit(1),
    db
      .select()
      .from(assetMaintenance)
      .where(and(eq(assetMaintenance.tenantId, tenant.id), eq(assetMaintenance.assetId, id)))
      .orderBy(desc(assetMaintenance.id))
      .limit(10),
  ]);
  return {
    ...toRow(asset),
    categoryName: category?.name ?? null,
    currentValue: category ? currentValue(asset, category) : null,
    currentAllocation: allocation ? toRow(allocation) : null,
    recentMaintenance: maintenance.map(toRow),
  };
}

export async function createAsset(tenant: TenantContext, _actor: AuthUser, input: CreateAssetInput): Promise<unknown> {
  must(await findCategory(tenant.id, input.categoryId), 'Category not found in this school');
  if (input.locationClassroomId) await assertClassroom(tenant.id, input.locationClassroomId);
  checkAssetShape({
    purchaseDate: input.purchaseDate ?? null,
    warrantyUntil: input.warrantyUntil ?? null,
    purchaseCost: input.purchaseCost ?? null,
    salvageValue: input.salvageValue ?? null,
  });

  const explicitTag = input.assetTag !== undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tag = input.assetTag ?? (await nextAssetTag(tenant.id));
    try {
      const [row] = await db
        .insert(assets)
        .values({
          tenantId: tenant.id,
          assetTag: tag,
          name: input.name,
          categoryId: input.categoryId,
          vendorId: input.vendorId ?? null,
          branchId: input.branchId ?? null,
          quantity: input.quantity ?? 1,
          serialNo: input.serialNo ?? null,
          model: input.model ?? null,
          purchaseDate: input.purchaseDate ?? null,
          purchaseCost: money(input.purchaseCost) ?? null,
          warrantyUntil: input.warrantyUntil ?? null,
          salvageValue: money(input.salvageValue) ?? null,
          locationClassroomId: input.locationClassroomId ?? null,
          status: input.status ?? 'in_store',
          condition: input.condition ?? 'good',
          notes: input.notes ?? null,
        })
        .returning();
      return toRow(row);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (explicitTag) throw new HttpError(409, 'That asset tag is already used in this school');
      // generated tag collided with a parallel request: try the next one
    }
  }
  throw new HttpError(409, 'Could not generate a unique asset tag, please try again');
}

export async function updateAsset(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateAssetInput,
): Promise<unknown> {
  const existing = notFound(await findAsset(tenant.id, id), 'Asset not found');
  if (existing.status === 'disposed') throw new HttpError(409, 'A disposed asset cannot be changed');

  if (input.categoryId) must(await findCategory(tenant.id, input.categoryId), 'Category not found in this school');
  if (input.locationClassroomId) await assertClassroom(tenant.id, input.locationClassroomId);

  checkAssetShape({
    purchaseDate: input.purchaseDate !== undefined ? input.purchaseDate : existing.purchaseDate,
    warrantyUntil: input.warrantyUntil !== undefined ? input.warrantyUntil : existing.warrantyUntil,
    purchaseCost: input.purchaseCost !== undefined ? input.purchaseCost : num(existing.purchaseCost),
    salvageValue: input.salvageValue !== undefined ? input.salvageValue : num(existing.salvageValue),
  });

  // an allocated asset has to come back before it can be stored or retired
  if (input.status === 'in_store' || input.status === 'retired') {
    const [{ total }] = await db
      .select({ total: count() })
      .from(assetAllocations)
      .where(and(eq(assetAllocations.tenantId, tenant.id), eq(assetAllocations.assetId, id), isNull(assetAllocations.returnedOn)));
    if (total > 0) throw new HttpError(409, 'Return the asset from its current allocation first');
  }

  const { purchaseCost, salvageValue, ...plain } = input;
  const [row] = await db
    .update(assets)
    .set({ ...plain, purchaseCost: money(purchaseCost), salvageValue: money(salvageValue) })
    .where(and(eq(assets.id, id), eq(assets.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// "Delete" disposes the asset: the row stays for history.
export async function disposeAsset(tenant: TenantContext, id: bigint, input: DisposeAssetInput): Promise<unknown> {
  const existing = notFound(await findAsset(tenant.id, id), 'Asset not found');
  if (existing.status === 'disposed') throw new HttpError(409, 'This asset is already disposed');

  const [[allocated], [openWork]] = await Promise.all([
    db
      .select({ total: count() })
      .from(assetAllocations)
      .where(and(eq(assetAllocations.tenantId, tenant.id), eq(assetAllocations.assetId, id), isNull(assetAllocations.returnedOn))),
    db
      .select({ total: count() })
      .from(assetMaintenance)
      .where(
        and(
          eq(assetMaintenance.tenantId, tenant.id),
          eq(assetMaintenance.assetId, id),
          or(eq(assetMaintenance.status, 'reported'), eq(assetMaintenance.status, 'in_progress')),
        ),
      ),
  ]);
  if (allocated.total > 0) throw new HttpError(409, 'Return the asset from its current allocation first');
  if (openWork.total > 0) throw new HttpError(409, 'Complete or cancel the open maintenance first');

  const disposedOn = input.disposedOn ?? todayStr();
  if (existing.purchaseDate && disposedOn < existing.purchaseDate) invalid('disposedOn', 'Cannot be before the purchase date');

  const [row] = await db
    .update(assets)
    .set({
      status: 'disposed',
      disposedOn,
      disposalValue: money(input.disposalValue),
      notes: input.notes ?? existing.notes,
      locationClassroomId: null,
    })
    .where(and(eq(assets.id, id), eq(assets.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// ================================================================ ALLOCATIONS
const ALREADY_ALLOCATED = 'This asset is already allocated: return it first';

export async function listAllocations(tenant: TenantContext, q: ListAllocationsInput): Promise<Page> {
  const where = and(
    eq(assetAllocations.tenantId, tenant.id),
    q.assetId ? eq(assetAllocations.assetId, q.assetId) : undefined,
    q.staffId ? eq(assetAllocations.staffId, q.staffId) : undefined,
    q.studentId ? eq(assetAllocations.studentId, q.studentId) : undefined,
    q.classroomId ? eq(assetAllocations.classroomId, q.classroomId) : undefined,
    q.open === undefined ? undefined : q.open ? isNull(assetAllocations.returnedOn) : isNotNull(assetAllocations.returnedOn),
    q.overdue
      ? and(isNull(assetAllocations.returnedOn), isNotNull(assetAllocations.expectedReturnOn), lte(assetAllocations.expectedReturnOn, daysFromToday(-1)))
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(assetAllocations), assetTag: assets.assetTag, assetName: assets.name })
      .from(assetAllocations)
      .innerJoin(assets, eq(assetAllocations.assetId, assets.id))
      .where(where)
      .orderBy(desc(assetAllocations.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(assetAllocations).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function createAllocation(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateAllocationInput,
): Promise<unknown> {
  const asset = must(await findAsset(tenant.id, input.assetId), 'Asset not found in this school');
  if (asset.status !== 'in_store' && asset.status !== 'in_use') {
    throw new HttpError(409, `An asset that is ${asset.status.replace('_', ' ')} cannot be allocated`);
  }

  const staffId = input.staffId ?? null;
  const classroomId = input.classroomId ?? null;
  const studentId = input.studentId ?? null; // not checked: students table does not exist yet
  if (staffId !== null) await assertActiveStaff(tenant.id, staffId);
  if (classroomId !== null) await assertClassroom(tenant.id, classroomId);

  const allocatedOn = input.allocatedOn ?? todayStr();
  if (input.expectedReturnOn && input.expectedReturnOn < allocatedOn) {
    invalid('expectedReturnOn', 'Cannot be before the allocation date');
  }

  const [open] = await db
    .select({ id: assetAllocations.id })
    .from(assetAllocations)
    .where(and(eq(assetAllocations.assetId, asset.id), isNull(assetAllocations.returnedOn)))
    .limit(1);
  if (open) throw new HttpError(409, ALREADY_ALLOCATED);

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(assetAllocations)
        .values({
          tenantId: tenant.id,
          assetId: asset.id,
          staffId,
          studentId,
          classroomId,
          allocatedOn,
          expectedReturnOn: input.expectedReturnOn ?? null,
          conditionOut: input.conditionOut ?? asset.condition,
          notes: input.notes ?? null,
        })
        .returning();
      await tx
        .update(assets)
        .set({ status: 'in_use', ...(classroomId !== null ? { locationClassroomId: classroomId } : {}) })
        .where(and(eq(assets.id, asset.id), eq(assets.tenantId, tenant.id)));
      return toRow(row);
    });
  } catch (e) {
    // two requests allocated the same asset at once: the unique index caught it
    if (isUniqueViolation(e)) throw new HttpError(409, ALREADY_ALLOCATED);
    throw e;
  }
}

export async function updateAllocation(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateAllocationInput,
): Promise<unknown> {
  const existing = notFound(await findAllocation(tenant.id, id), 'Allocation not found');
  if (existing.returnedOn) throw new HttpError(409, 'A returned allocation cannot be changed');
  if (input.expectedReturnOn && existing.allocatedOn && input.expectedReturnOn < existing.allocatedOn) {
    invalid('expectedReturnOn', 'Cannot be before the allocation date');
  }
  const [row] = await db
    .update(assetAllocations)
    .set(input)
    .where(and(eq(assetAllocations.id, id), eq(assetAllocations.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

export async function returnAllocation(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: ReturnAllocationInput,
): Promise<unknown> {
  const existing = notFound(await findAllocation(tenant.id, id), 'Allocation not found');
  if (existing.returnedOn) throw new HttpError(409, 'This allocation is already returned');

  const returnedOn = input.returnedOn ?? todayStr();
  if (existing.allocatedOn && returnedOn < existing.allocatedOn) invalid('returnedOn', 'Cannot be before the allocation date');

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(assetAllocations)
      .set({ returnedOn, conditionIn: input.conditionIn, notes: input.notes === undefined ? existing.notes : input.notes })
      .where(and(eq(assetAllocations.id, id), eq(assetAllocations.tenantId, tenant.id)))
      .returning();

    // back to the store, with the condition it came back in. An asset that is under repair stays under repair.
    const [asset] = await tx
      .select({ status: assets.status })
      .from(assets)
      .where(and(eq(assets.id, existing.assetId), eq(assets.tenantId, tenant.id)))
      .limit(1);
    await tx
      .update(assets)
      .set({ condition: input.conditionIn, ...(asset?.status === 'in_use' ? { status: 'in_store' } : {}) })
      .where(and(eq(assets.id, existing.assetId), eq(assets.tenantId, tenant.id)));
    return toRow(row);
  });
}

// ================================================================ MAINTENANCE
interface MaintenanceShape {
  maintenanceType: string;
  description: string | null;
  reportedOn: string | null;
  startedOn: string | null;
  completedOn: string | null;
  cost: number | null;
  labourCost: number | null;
  partsCost: number | null;
  vendorId: bigint | null;
  status: string;
  nextDueOn: string | null;
}

// Applies defaults and checks every rule. Used by both create and update.
function normaliseMaintenance(s: MaintenanceShape): MaintenanceShape {
  const out = { ...s };
  if (out.status === 'in_progress' && !out.startedOn) out.startedOn = todayStr();
  if (out.status === 'completed' && !out.completedOn) out.completedOn = todayStr();
  if (out.status !== 'completed' && out.completedOn) invalid('completedOn', 'Only a completed record has a completion date');

  if (out.reportedOn && out.startedOn && out.startedOn < out.reportedOn) invalid('startedOn', 'Cannot be before reportedOn');
  if (out.startedOn && out.completedOn && out.completedOn < out.startedOn) invalid('completedOn', 'Cannot be before startedOn');
  if (out.reportedOn && out.completedOn && out.completedOn < out.reportedOn) invalid('completedOn', 'Cannot be before reportedOn');

  const reference = out.completedOn ?? out.startedOn ?? out.reportedOn;
  if (out.nextDueOn && reference && out.nextDueOn < reference) invalid('nextDueOn', 'Cannot be before the work dates');

  if (out.labourCost !== null || out.partsCost !== null) {
    const sumCents = Math.round((out.labourCost ?? 0) * 100) + Math.round((out.partsCost ?? 0) * 100);
    if (out.cost === null) out.cost = sumCents / 100;
    else if (Math.round(out.cost * 100) !== sumCents) invalid('cost', 'Must equal labourCost + partsCost');
  }
  return out;
}

const maintenanceColumns = (s: MaintenanceShape) => ({
  maintenanceType: s.maintenanceType,
  description: s.description,
  reportedOn: s.reportedOn,
  startedOn: s.startedOn,
  completedOn: s.completedOn,
  cost: money(s.cost) ?? null,
  labourCost: money(s.labourCost) ?? null,
  partsCost: money(s.partsCost) ?? null,
  vendorId: s.vendorId,
  status: s.status,
  nextDueOn: s.nextDueOn,
});

// A repair in progress puts the asset under repair; when the last one ends it goes back to use / store.
async function syncRepairState(tx: Tx, tenantId: bigint, assetId: bigint): Promise<void> {
  const [{ total: repairs }] = await tx
    .select({ total: count() })
    .from(assetMaintenance)
    .where(
      and(
        eq(assetMaintenance.tenantId, tenantId),
        eq(assetMaintenance.assetId, assetId),
        eq(assetMaintenance.status, 'in_progress'),
        eq(assetMaintenance.maintenanceType, 'repair'),
      ),
    );
  const [asset] = await tx
    .select({ status: assets.status })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId)))
    .limit(1);
  if (!asset) return;

  if (repairs > 0 && (asset.status === 'in_use' || asset.status === 'in_store')) {
    await tx.update(assets).set({ status: 'under_repair' }).where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId)));
  } else if (repairs === 0 && asset.status === 'under_repair') {
    const [{ total: allocated }] = await tx
      .select({ total: count() })
      .from(assetAllocations)
      .where(and(eq(assetAllocations.tenantId, tenantId), eq(assetAllocations.assetId, assetId), isNull(assetAllocations.returnedOn)));
    await tx
      .update(assets)
      .set({ status: allocated > 0 ? 'in_use' : 'in_store' })
      .where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId)));
  }
}

export async function listMaintenance(tenant: TenantContext, q: ListMaintenanceInput): Promise<Page> {
  const where = and(
    eq(assetMaintenance.tenantId, tenant.id),
    q.assetId ? eq(assetMaintenance.assetId, q.assetId) : undefined,
    q.status ? eq(assetMaintenance.status, q.status) : undefined,
    q.maintenanceType ? eq(assetMaintenance.maintenanceType, q.maintenanceType) : undefined,
    q.dueWithinDays
      ? and(
          isNotNull(assetMaintenance.nextDueOn),
          lte(assetMaintenance.nextDueOn, daysFromToday(q.dueWithinDays)),
          ne(assetMaintenance.status, 'cancelled'),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ ...getTableColumns(assetMaintenance), assetTag: assets.assetTag, assetName: assets.name })
      .from(assetMaintenance)
      .innerJoin(assets, eq(assetMaintenance.assetId, assets.id))
      .where(where)
      .orderBy(desc(assetMaintenance.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(assetMaintenance).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function createMaintenance(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateMaintenanceInput,
): Promise<unknown> {
  const asset = must(await findAsset(tenant.id, input.assetId), 'Asset not found in this school');
  if (asset.status === 'disposed') throw new HttpError(409, 'A disposed asset cannot have maintenance');

  const shape = normaliseMaintenance({
    maintenanceType: input.maintenanceType,
    description: input.description ?? null,
    reportedOn: input.reportedOn ?? input.startedOn ?? input.completedOn ?? todayStr(),
    startedOn: input.startedOn ?? null,
    completedOn: input.completedOn ?? null,
    cost: input.cost ?? null,
    labourCost: input.labourCost ?? null,
    partsCost: input.partsCost ?? null,
    vendorId: input.vendorId ?? null,
    status: input.status ?? 'reported',
    nextDueOn: input.nextDueOn ?? null,
  });

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(assetMaintenance)
      .values({ ...maintenanceColumns(shape), tenantId: tenant.id, assetId: asset.id })
      .returning();
    await syncRepairState(tx, tenant.id, asset.id);
    return toRow(row);
  });
}

export async function updateMaintenance(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateMaintenanceInput,
): Promise<unknown> {
  const existing = notFound(await findMaintenance(tenant.id, id), 'Maintenance record not found');
  if (existing.status === 'completed' || existing.status === 'cancelled') {
    throw new HttpError(409, `A ${existing.status} record cannot be changed`);
  }

  const shape = normaliseMaintenance({
    maintenanceType: input.maintenanceType ?? existing.maintenanceType,
    description: input.description !== undefined ? input.description : existing.description,
    reportedOn: input.reportedOn !== undefined ? input.reportedOn : existing.reportedOn,
    startedOn: input.startedOn !== undefined ? input.startedOn : existing.startedOn,
    completedOn: input.completedOn !== undefined ? input.completedOn : existing.completedOn,
    cost: input.cost !== undefined ? input.cost : num(existing.cost),
    labourCost: input.labourCost !== undefined ? input.labourCost : num(existing.labourCost),
    partsCost: input.partsCost !== undefined ? input.partsCost : num(existing.partsCost),
    vendorId: input.vendorId !== undefined ? input.vendorId : existing.vendorId,
    status: input.status ?? existing.status,
    nextDueOn: input.nextDueOn !== undefined ? input.nextDueOn : existing.nextDueOn,
  });

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(assetMaintenance)
      .set(maintenanceColumns(shape))
      .where(and(eq(assetMaintenance.id, id), eq(assetMaintenance.tenantId, tenant.id)))
      .returning();
    await syncRepairState(tx, tenant.id, existing.assetId);
    return toRow(row);
  });
}

// "Delete" cancels the record. A completed record is history and stays.
export async function cancelMaintenance(tenant: TenantContext, id: bigint): Promise<void> {
  const existing = notFound(await findMaintenance(tenant.id, id), 'Maintenance record not found');
  if (existing.status === 'completed') throw new HttpError(409, 'A completed record cannot be cancelled');
  if (existing.status === 'cancelled') return;
  await db.transaction(async (tx) => {
    await tx
      .update(assetMaintenance)
      .set({ status: 'cancelled' })
      .where(and(eq(assetMaintenance.id, id), eq(assetMaintenance.tenantId, tenant.id)));
    await syncRepairState(tx, tenant.id, existing.assetId);
  });
}