import { and, asc, count, eq, ilike, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { CreateSubjectInput, ListSubjectsInput, UpdateSubjectInput } from './subjects.schemas';

// RULES (same as members and staff): every query has tenantId = tenant.id, and deleted rows (deletedAt set) are invisible.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

type SubjectRow = typeof subjects.$inferSelect;
type SubjectInsert = typeof subjects.$inferInsert;

const HIDDEN = new Set<string>(['tenantId', 'deletedAt', 'deletedBy']);
const toSubject = (s: SubjectRow) => Object.fromEntries(Object.entries(s).filter(([key]) => !HIDDEN.has(key)));

const CODE_TAKEN = 'That subject code is already used in this school';

async function loadSubject(tenantId: bigint, id: bigint): Promise<SubjectRow> {
  const [row] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.id, id), eq(subjects.tenantId, tenantId), isNull(subjects.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Subject not found');
  return row;
}

// API input -> database columns (credits is numeric, so it is stored as text with one decimal).
function toColumns(input: UpdateSubjectInput): Partial<SubjectInsert> {
  const { credits, ...plain } = input;
  const columns: Partial<SubjectInsert> = { ...plain };
  if (credits !== undefined) columns.credits = credits === null ? null : credits.toFixed(1);
  return columns;
}

export async function listSubjects(
  tenant: TenantContext,
  q: ListSubjectsInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  const where = and(
    eq(subjects.tenantId, tenant.id),
    isNull(subjects.deletedAt),
    q.subjectType ? eq(subjects.subjectType, q.subjectType) : undefined,
    q.status ? eq(subjects.status, q.status) : undefined,
    q.q ? or(ilike(subjects.name, `%${q.q}%`), ilike(subjects.code, `%${q.q}%`)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(subjects)
      .where(where)
      .orderBy(asc(subjects.name))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(subjects).where(where),
  ]);

  return { rows: rows.map(toSubject), meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
}

export async function getSubject(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toSubject(await loadSubject(tenant.id, id));
}

export async function createSubject(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateSubjectInput,
): Promise<unknown> {
  try {
    const [row] = await db
      .insert(subjects)
      .values({
        ...toColumns(input),
        tenantId: tenant.id,
        code: input.code,
        name: input.name,
        subjectType: input.subjectType,
      })
      .returning();
    return toSubject(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CODE_TAKEN);
    throw e;
  }
}

export async function updateSubject(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateSubjectInput,
): Promise<unknown> {
  await loadSubject(tenant.id, id);
  try {
    const [row] = await db
      .update(subjects)
      .set(toColumns(input))
      .where(and(eq(subjects.id, id), eq(subjects.tenantId, tenant.id), isNull(subjects.deletedAt)))
      .returning();
    return toSubject(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CODE_TAKEN);
    throw e;
  }
}

// Soft delete. When class_subjects / timetable exist, block deleting a subject that is still in use.
export async function removeSubject(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadSubject(tenant.id, id);
  await db
    .update(subjects)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(subjects.id, id), eq(subjects.tenantId, tenant.id)));
}