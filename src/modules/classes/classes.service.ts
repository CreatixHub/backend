import { and, asc, count, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { classes, classrooms, classSubjects, sections, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateClassInput,
  CreateSectionInput,
  ListClassesInput,
  ListSectionsInput,
  SetClassSubjectsInput,
  UpdateClassInput,
  UpdateSectionInput,
} from './classes.schemas';

// RULES (same as members, staff and subjects): every query has tenantId = tenant.id,
// and deleted rows (deletedAt set) are invisible.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

const HIDDEN = new Set<string>(['tenantId', 'deletedAt', 'deletedBy']);
const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => !HIDDEN.has(key)));

interface Page {
  rows: unknown[];
  meta: { page: number; limit: number; total: number; pages: number };
}
const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

const CLASS_CODE_TAKEN = 'That class code is already used in this school';
const SECTION_NAME_TAKEN = 'This class already has a section with that name';

// ---------------------------------------------------------------- classes
async function loadClass(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(classes)
    .where(and(eq(classes.id, id), eq(classes.tenantId, tenantId), isNull(classes.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Class not found');
  return row;
}

export async function listClasses(tenant: TenantContext, q: ListClassesInput): Promise<Page> {
  const where = and(
    eq(classes.tenantId, tenant.id),
    isNull(classes.deletedAt),
    q.status ? eq(classes.status, q.status) : undefined,
    q.q ? or(ilike(classes.name, `%${q.q}%`), ilike(classes.code, `%${q.q}%`)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(classes)
      .where(where)
      .orderBy(asc(classes.gradeLevel), asc(classes.displayOrder), asc(classes.name))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(classes).where(where),
  ]);

  // how many sections each class on this page has
  const ids = rows.map((r) => r.id);
  const counts =
    ids.length === 0
      ? []
      : await db
          .select({ classId: sections.classId, total: count() })
          .from(sections)
          .where(and(inArray(sections.classId, ids), isNull(sections.deletedAt)))
          .groupBy(sections.classId);
  const sectionCount = new Map(counts.map((c) => [c.classId, c.total]));

  return {
    rows: rows.map((r) => ({ ...toRow(r), sectionCount: sectionCount.get(r.id) ?? 0 })),
    meta: pageMeta(q.page, q.limit, total),
  };
}

// One class with its sections and its subjects.
export async function getClass(tenant: TenantContext, id: bigint): Promise<unknown> {
  const cls = await loadClass(tenant.id, id);
  const [sectionRows, subjectRows] = await Promise.all([
    db
      .select()
      .from(sections)
      .where(and(eq(sections.classId, id), eq(sections.tenantId, tenant.id), isNull(sections.deletedAt)))
      .orderBy(asc(sections.name)),
    loadClassSubjects(tenant.id, id),
  ]);
  return { ...toRow(cls), sections: sectionRows.map(toRow), subjects: subjectRows };
}

export async function createClass(tenant: TenantContext, _actor: AuthUser, input: CreateClassInput): Promise<unknown> {
  try {
    const [row] = await db
      .insert(classes)
      .values({ ...input, tenantId: tenant.id })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CLASS_CODE_TAKEN);
    throw e;
  }
}

export async function updateClass(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateClassInput,
): Promise<unknown> {
  await loadClass(tenant.id, id);
  try {
    const [row] = await db
      .update(classes)
      .set(input)
      .where(and(eq(classes.id, id), eq(classes.tenantId, tenant.id), isNull(classes.deletedAt)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, CLASS_CODE_TAKEN);
    throw e;
  }
}

// Soft delete, but only when the class has no sections left.
export async function removeClass(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadClass(tenant.id, id);
  const [{ total }] = await db
    .select({ total: count() })
    .from(sections)
    .where(and(eq(sections.classId, id), eq(sections.tenantId, tenant.id), isNull(sections.deletedAt)));
  if (total > 0) throw new HttpError(409, 'Delete this class\'s sections first');
  await db
    .update(classes)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(classes.id, id), eq(classes.tenantId, tenant.id)));
}

// ---------------------------------------------------------------- sections
async function loadSection(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(sections)
    .where(and(eq(sections.id, id), eq(sections.tenantId, tenantId), isNull(sections.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Section not found');
  return row;
}

async function assertClassroom(tenantId: bigint, classroomId?: bigint | null) {
  if (!classroomId) return;
  const [room] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(and(eq(classrooms.id, classroomId), eq(classrooms.tenantId, tenantId), isNull(classrooms.deletedAt)))
    .limit(1);
  if (!room) throw new HttpError(400, 'Classroom not found in this school');
}

export async function listSections(tenant: TenantContext, q: ListSectionsInput): Promise<Page> {
  const where = and(
    eq(sections.tenantId, tenant.id),
    isNull(sections.deletedAt),
    q.classId ? eq(sections.classId, q.classId) : undefined,
    q.status ? eq(sections.status, q.status) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ section: sections, className: classes.name })
      .from(sections)
      .innerJoin(classes, eq(sections.classId, classes.id))
      .where(where)
      .orderBy(asc(classes.gradeLevel), asc(sections.name))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(sections).where(where),
  ]);

  return {
    rows: rows.map((r) => ({ ...toRow(r.section), className: r.className })),
    meta: pageMeta(q.page, q.limit, total),
  };
}

export async function getSection(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toRow(await loadSection(tenant.id, id));
}

export async function createSection(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateSectionInput,
): Promise<unknown> {
  await loadClass(tenant.id, input.classId);
  await assertClassroom(tenant.id, input.defaultClassroomId);
  try {
    const [row] = await db
      .insert(sections)
      .values({ ...input, tenantId: tenant.id })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SECTION_NAME_TAKEN);
    throw e;
  }
}

export async function updateSection(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateSectionInput,
): Promise<unknown> {
  await loadSection(tenant.id, id);
  await assertClassroom(tenant.id, input.defaultClassroomId);
  try {
    const [row] = await db
      .update(sections)
      .set(input)
      .where(and(eq(sections.id, id), eq(sections.tenantId, tenant.id), isNull(sections.deletedAt)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SECTION_NAME_TAKEN);
    throw e;
  }
}

// Soft delete. When enrollments exist, block deleting a section that still has students.
export async function removeSection(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadSection(tenant.id, id);
  await db
    .update(sections)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(sections.id, id), eq(sections.tenantId, tenant.id)));
}

// ---------------------------------------------------------------- subjects of a class
async function loadClassSubjects(tenantId: bigint, classId: bigint) {
  return db
    .select({
      subjectId: classSubjects.subjectId,
      code: subjects.code,
      name: subjects.name,
      isElective: classSubjects.isElective,
      periodsPerWeek: classSubjects.periodsPerWeek,
      displayOrder: classSubjects.displayOrder,
      examMarks: classSubjects.examMarks,
      internalMarks: classSubjects.internalMarks,
      passMarks: classSubjects.passMarks,
    })
    .from(classSubjects)
    .innerJoin(subjects, eq(classSubjects.subjectId, subjects.id))
    .where(and(eq(classSubjects.classId, classId), eq(classSubjects.tenantId, tenantId)))
    .orderBy(asc(classSubjects.displayOrder), asc(subjects.name));
}

export async function getClassSubjects(tenant: TenantContext, classId: bigint): Promise<unknown> {
  await loadClass(tenant.id, classId);
  return loadClassSubjects(tenant.id, classId);
}

// Replaces the whole list in one transaction: send the complete set of subjects the class should have.
export async function setClassSubjects(
  tenant: TenantContext,
  classId: bigint,
  input: SetClassSubjectsInput,
): Promise<unknown> {
  await loadClass(tenant.id, classId);

  const wanted = input.subjects.map((s) => s.subjectId);
  if (wanted.length > 0) {
    const found = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, tenant.id), isNull(subjects.deletedAt), inArray(subjects.id, wanted)));
    const missing = wanted.filter((w) => !found.some((f) => f.id === w));
    if (missing.length > 0) throw new HttpError(400, `Unknown subject: ${missing.join(', ')}`);
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(classSubjects)
      .where(and(eq(classSubjects.classId, classId), eq(classSubjects.tenantId, tenant.id)));
    if (input.subjects.length > 0) {
      await tx.insert(classSubjects).values(
        input.subjects.map((s) => ({
          classId,
          subjectId: s.subjectId,
          tenantId: tenant.id,
          isElective: s.isElective,
          periodsPerWeek: s.periodsPerWeek ?? null,
          displayOrder: s.displayOrder,
          examMarks: s.examMarks.toFixed(2),
          internalMarks: s.internalMarks.toFixed(2),
          passMarks: s.passMarks == null ? null : s.passMarks.toFixed(2),
        })),
      );
    }
  });

  return loadClassSubjects(tenant.id, classId);
}