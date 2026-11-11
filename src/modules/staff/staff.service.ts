import { and, asc, count, eq, ilike, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import { memberships, staff } from '../../db/schema';
import { encryptField } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { CreateStaffInput, ListStaffInput, UpdateStaffInput } from './staff.schemas';

// RULES (same as members): every query has tenantId = tenant.id, and soft-deleted rows (deletedAt set) are invisible.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === UNIQUE_VIOLATION;
}

type StaffRow = typeof staff.$inferSelect;
type StaffInsert = typeof staff.$inferInsert;

// Never sent to the client. The three *_enc columns hold encrypted values and are replaced by yes/no flags.
const HIDDEN = new Set<string>(['tenantId', 'deletedAt', 'deletedBy', 'nationalIdEnc', 'panEnc', 'bankAccountEnc']);

const toStaff = (s: StaffRow) => ({
  ...Object.fromEntries(Object.entries(s).filter(([key]) => !HIDDEN.has(key))),
  hasNationalId: s.nationalIdEnc !== null,
  hasPan: s.panEnc !== null,
  hasBankAccount: s.bankAccountEnc !== null,
});

const joinName = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

async function loadStaff(tenantId: bigint, id: bigint): Promise<StaffRow> {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Staff member not found');
  return row;
}

// The login account must belong to THIS school and be free; the manager must be staff of THIS school.
async function assertRelations(tenantId: bigint, userId?: bigint | null, reportsToId?: bigint | null, selfId?: bigint) {
  if (userId) {
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), eq(memberships.status, 'active')))
      .limit(1);
    if (!member) throw new HttpError(400, 'That user is not an active member of this school');

    const [linked] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.tenantId, tenantId),
          eq(staff.userId, userId),
          isNull(staff.deletedAt),
          selfId === undefined ? undefined : ne(staff.id, selfId),
        ),
      )
      .limit(1);
    if (linked) throw new HttpError(409, 'That user is already linked to another staff member');
  }

  if (reportsToId) {
    if (selfId !== undefined && reportsToId === selfId) {
      throw new HttpError(400, 'A staff member cannot report to themselves');
    }
    const [manager] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, reportsToId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
      .limit(1);
    if (!manager) throw new HttpError(400, 'Manager not found in this school');
  }
}

// API input -> database columns: the three sensitive values are encrypted, experience becomes numeric text.
function toColumns(input: UpdateStaffInput): Partial<StaffInsert> {
  const { nationalId, pan, bankAccountNumber, experienceYears, ...plain } = input;
  const columns: Partial<StaffInsert> = { ...plain };
  if (nationalId !== undefined) columns.nationalIdEnc = nationalId === null ? null : encryptField(nationalId);
  if (pan !== undefined) columns.panEnc = pan === null ? null : encryptField(pan);
  if (bankAccountNumber !== undefined) {
    columns.bankAccountEnc = bankAccountNumber === null ? null : encryptField(bankAccountNumber);
  }
  if (experienceYears !== undefined) {
    columns.experienceYears = experienceYears === null ? null : experienceYears.toFixed(1);
  }
  return columns;
}

// EMP-0001, EMP-0002 ... counted per school (deleted staff still count, so numbers are never reused).
async function nextEmployeeNo(tenantId: bigint, offset: number): Promise<string> {
  const [{ total }] = await db.select({ total: count() }).from(staff).where(eq(staff.tenantId, tenantId));
  return `EMP-${String(total + 1 + offset).padStart(4, '0')}`;
}

export async function listStaff(
  tenant: TenantContext,
  q: ListStaffInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  const where = and(
    eq(staff.tenantId, tenant.id),
    isNull(staff.deletedAt),
    q.staffType ? eq(staff.staffType, q.staffType) : undefined,
    q.status ? eq(staff.status, q.status) : undefined,
    q.employmentType ? eq(staff.employmentType, q.employmentType) : undefined,
    q.q
      ? or(ilike(staff.fullName, `%${q.q}%`), ilike(staff.employeeNo, `%${q.q}%`), ilike(staff.email, `%${q.q}%`))
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(where)
      .orderBy(asc(staff.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(staff).where(where),
  ]);

  return { rows: rows.map(toStaff), meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
}

export async function getStaff(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toStaff(await loadStaff(tenant.id, id));
}

export async function createStaff(tenant: TenantContext, _actor: AuthUser, input: CreateStaffInput): Promise<unknown> {
  await assertRelations(tenant.id, input.userId, input.reportsToId);
  const columns = toColumns(input);

  for (let attempt = 0; attempt < 3; attempt++) {
    const employeeNo = input.employeeNo ?? (await nextEmployeeNo(tenant.id, attempt));
    try {
      const [row] = await db
        .insert(staff)
        .values({
          ...columns,
          tenantId: tenant.id,
          employeeNo,
          fullName: joinName(input.firstName, input.lastName),
          staffType: input.staffType,
          employmentType: input.employmentType,
          joinedOn: input.joinedOn,
        })
        .returning();
      return toStaff(row);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (input.employeeNo) throw new HttpError(409, 'That employee number is already used in this school');
      // a generated number collided with another request at the same moment: try the next one
    }
  }
  throw new HttpError(409, 'Could not generate an employee number, please try again');
}

export async function updateStaff(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateStaffInput,
): Promise<unknown> {
  const existing = await loadStaff(tenant.id, id);
  await assertRelations(tenant.id, input.userId, input.reportsToId, id);

  // leaving the school needs a leaving date (either sent now or already on file)
  const nextStatus = input.status ?? existing.status;
  const nextLeftOn = input.leftOn !== undefined ? input.leftOn : existing.leftOn;
  if (nextStatus === 'left' && !nextLeftOn) {
    throw new HttpError(400, 'Validation failed', [{ field: 'leftOn', message: 'Required when status is left' }]);
  }

  const set = toColumns(input);
  if (input.firstName !== undefined || input.lastName !== undefined) {
    set.fullName = joinName(
      input.firstName ?? existing.firstName,
      input.lastName !== undefined ? input.lastName : existing.lastName,
    );
  }

  try {
    const [row] = await db
      .update(staff)
      .set(set)
      .where(and(eq(staff.id, id), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
      .returning();
    return toStaff(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That employee number is already used in this school');
    throw e;
  }
}

// Soft delete: the row stays (history, payroll later); it just disappears from every list and lookup.
export async function removeStaff(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadStaff(tenant.id, id);
  await db
    .update(staff)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenant.id)));
}