import { and, asc, count, desc, eq, getTableColumns, gte, ilike, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../db';
import { classes, classSubjects, homework, homeworkSubmissions, sections, staff, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isRowScopedFor } from '../../lib/ownership';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateHomeworkInput,
  GradeSubmissionInput,
  ListHomeworkInput,
  ListSubmissionsInput,
  RecordSubmissionInput,
  UpdateHomeworkInput,
} from './homework.schemas';

// RULES (same as the other modules): every query has tenantId = tenant.id.
// enrollments, files and academic_years do not exist yet, so enrollmentId / fileId / academicYearId are NOT checked.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === UNIQUE_VIOLATION;
}

const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

interface Page {
  rows: unknown[];
  meta: { page: number; limit: number; total: number; pages: number };
}
const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

type HomeworkInsert = typeof homework.$inferInsert;

// numeric columns are stored as text with two decimals
const fixed = (n: number | null | undefined): string | null | undefined => (n == null ? n : n.toFixed(2));

// ---------------------------------------------------------------- shared checks
async function loadSection(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(sections)
    .where(and(eq(sections.id, id), eq(sections.tenantId, tenantId), isNull(sections.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Section not found in this school');
  return row;
}

async function assertSubjectTaughtInClass(tenantId: bigint, classId: bigint, subjectId: bigint) {
  const [row] = await db
    .select({ subjectId: classSubjects.subjectId })
    .from(classSubjects)
    .where(
      and(
        eq(classSubjects.tenantId, tenantId),
        eq(classSubjects.classId, classId),
        eq(classSubjects.subjectId, subjectId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(400, 'That subject is not taught in this class (set the class subjects first)');
}

// The teacher must be an ACTIVE, TEACHING staff member of this school.
async function assertTeacher(tenantId: bigint, teacherId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.id, teacherId),
        eq(staff.tenantId, tenantId),
        isNull(staff.deletedAt),
        eq(staff.staffType, 'teaching'),
        eq(staff.status, 'active'),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(400, 'Teacher must be an active teaching staff member of this school');
}

// The staff member linked to the logged-in user (null for an admin who is not staff).
async function staffIdOfUser(tenantId: bigint, userId: bigint): Promise<bigint | null> {
  const [mine] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.userId, userId), isNull(staff.deletedAt)))
    .limit(1);
  return mine?.id ?? null;
}

// ================================================================ HOMEWORK
async function loadHomework(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(homework)
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Homework not found');
  return row;
}

// A homework row together with the names the screens need.
const joined = () =>
  db
    .select({
      ...getTableColumns(homework),
      sectionName: sections.name,
      className: classes.name,
      subjectName: subjects.name,
      teacherName: staff.fullName,
    })
    .from(homework)
    .innerJoin(sections, eq(homework.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .innerJoin(subjects, eq(homework.subjectId, subjects.id))
    .innerJoin(staff, eq(homework.teacherId, staff.id));

// API input -> database columns
function toColumns(input: Partial<CreateHomeworkInput>): Partial<HomeworkInsert> {
  const { dueAt, maxMarks, latePenaltyPercent, ...plain } = input;
  const columns: Partial<HomeworkInsert> = { ...plain };
  if (dueAt !== undefined) columns.dueAt = new Date(dueAt);
  if (maxMarks !== undefined) columns.maxMarks = fixed(maxMarks);
  if (latePenaltyPercent !== undefined) columns.latePenaltyPercent = fixed(latePenaltyPercent);
  return columns;
}

// HW-2026-0001, HW-2026-0002 ... counted per school and year.
async function nextHomeworkCode(tenantId: bigint, year: string, offset: number): Promise<string> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(homework)
    .where(and(eq(homework.tenantId, tenantId), ilike(homework.homeworkCode, `HW-${year}-%`)));
  return `HW-${year}-${String(total + 1 + offset).padStart(4, '0')}`;
}

export async function listHomework(tenant: TenantContext, q: ListHomeworkInput): Promise<Page> {
  const where = and(
    eq(homework.tenantId, tenant.id),
    q.sectionId ? eq(homework.sectionId, q.sectionId) : undefined,
    q.subjectId ? eq(homework.subjectId, q.subjectId) : undefined,
    q.teacherId ? eq(homework.teacherId, q.teacherId) : undefined,
    q.academicYearId ? eq(homework.academicYearId, q.academicYearId) : undefined,
    q.status ? eq(homework.status, q.status) : undefined,
    q.homeworkType ? eq(homework.homeworkType, q.homeworkType) : undefined,
    q.dueAfter ? gte(homework.dueAt, new Date(q.dueAfter)) : undefined,
    q.dueBefore ? lte(homework.dueAt, new Date(q.dueBefore)) : undefined,
    q.q ? or(ilike(homework.title, `%${q.q}%`), ilike(homework.homeworkCode, `%${q.q}%`)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    joined()
      .where(where)
      .orderBy(desc(homework.dueAt), desc(homework.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(homework).where(where),
  ]);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

// One homework with how many submissions are in each status.
export async function getHomework(tenant: TenantContext, id: bigint): Promise<unknown> {
  const [row] = await joined()
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Homework not found');

  const counts = await db
    .select({ status: homeworkSubmissions.status, total: count() })
    .from(homeworkSubmissions)
    .where(and(eq(homeworkSubmissions.homeworkId, id), eq(homeworkSubmissions.tenantId, tenant.id)))
    .groupBy(homeworkSubmissions.status);

  return { ...toRow(row), submissionCounts: Object.fromEntries(counts.map((c) => [c.status, c.total])) };
}

export async function createHomework(
  tenant: TenantContext,
  actor: AuthUser,
  input: CreateHomeworkInput,
): Promise<unknown> {
  const section = await loadSection(tenant.id, input.sectionId);
  await assertSubjectTaughtInClass(tenant.id, section.classId, input.subjectId);

  // no teacherId sent: it is the staff member linked to the logged-in user
  let teacherId = input.teacherId;
  if (teacherId === undefined) {
    const mine = await staffIdOfUser(tenant.id, actor.id);
    if (mine === null) throw new HttpError(400, 'Send teacherId: your account is not linked to a staff member');
    teacherId = mine;
  }
  await assertTeacher(tenant.id, teacherId);

  const columns = toColumns(input);
  const year = input.assignedOn.slice(0, 4);

  for (let attempt = 0; attempt < 5; attempt++) {
    const homeworkCode = await nextHomeworkCode(tenant.id, year, attempt);
    try {
      const [row] = await db
        .insert(homework)
        .values({
          ...columns,
          tenantId: tenant.id,
          homeworkCode,
          sectionId: input.sectionId,
          subjectId: input.subjectId,
          teacherId,
          academicYearId: input.academicYearId,
          title: input.title,
          assignedOn: input.assignedOn,
          dueAt: new Date(input.dueAt),
        })
        .returning();
      return toRow(row);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // the generated code collided with another request at the same moment: try the next one
    }
  }
  throw new HttpError(409, 'Could not generate a homework code, please try again');
}

export async function updateHomework(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateHomeworkInput,
): Promise<unknown> {
  const existing = await loadHomework(tenant.id, id);
  if (existing.status === 'closed') throw new HttpError(409, 'Closed homework cannot be edited');

  if (input.subjectId !== undefined && input.subjectId !== existing.subjectId) {
    if (existing.status !== 'draft') throw new HttpError(409, 'The subject cannot be changed after publishing');
    const section = await loadSection(tenant.id, existing.sectionId);
    await assertSubjectTaughtInClass(tenant.id, section.classId, input.subjectId);
  }
  if (input.teacherId !== undefined) await assertTeacher(tenant.id, input.teacherId);

  const allowLate = input.allowLate ?? existing.allowLate;
  const penalty = input.latePenaltyPercent !== undefined ? input.latePenaltyPercent : existing.latePenaltyPercent;
  if (penalty != null && !allowLate) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'latePenaltyPercent', message: 'Needs allowLate: true' },
    ]);
  }

  if (input.dueAt !== undefined || input.assignedOn !== undefined) {
    const dueDay = input.dueAt !== undefined ? input.dueAt.slice(0, 10) : existing.dueAt.toISOString().slice(0, 10);
    const assignedOn = input.assignedOn ?? existing.assignedOn;
    if (dueDay < assignedOn) {
      throw new HttpError(400, 'Validation failed', [{ field: 'dueAt', message: 'Cannot be before assignedOn' }]);
    }
  }

  const [row] = await db
    .update(homework)
    .set(toColumns(input))
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// draft -> published: students can now submit
export async function publishHomework(tenant: TenantContext, id: bigint): Promise<unknown> {
  const existing = await loadHomework(tenant.id, id);
  if (existing.status !== 'draft') throw new HttpError(409, 'Only a draft can be published');
  if (existing.dueAt <= new Date()) throw new HttpError(400, 'The due date has already passed: change it first');
  const [row] = await db
    .update(homework)
    .set({ status: 'published' })
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// published -> closed: no more submissions
export async function closeHomework(tenant: TenantContext, id: bigint): Promise<unknown> {
  const existing = await loadHomework(tenant.id, id);
  if (existing.status !== 'published') throw new HttpError(409, 'Only a published homework can be closed');
  const [row] = await db
    .update(homework)
    .set({ status: 'closed' })
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// Real delete (the spec has no soft-delete column), only for a draft nobody has seen.
export async function removeHomework(tenant: TenantContext, id: bigint): Promise<void> {
  const existing = await loadHomework(tenant.id, id);
  if (existing.status !== 'draft') throw new HttpError(409, 'Only a draft can be deleted: close it instead');
  await db.delete(homework).where(and(eq(homework.id, id), eq(homework.tenantId, tenant.id)));
}

// ================================================================ SUBMISSIONS
export async function listSubmissions(tenant: TenantContext, homeworkId: bigint, q: ListSubmissionsInput): Promise<Page> {
  await loadHomework(tenant.id, homeworkId);
  // homework_submissions keys only by enrollment_id; fail closed until enrollments table exists
  if (isRowScopedFor(tenant, 'homework.view')) {
    return { rows: [], meta: pageMeta(q.page, q.limit, 0) };
  }
  const where = and(
    eq(homeworkSubmissions.tenantId, tenant.id),
    eq(homeworkSubmissions.homeworkId, homeworkId),
    q.status ? eq(homeworkSubmissions.status, q.status) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(homeworkSubmissions)
      .where(where)
      .orderBy(asc(homeworkSubmissions.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(homeworkSubmissions).where(where),
  ]);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

// Records (or resubmits) one student's answer. Staff use it for now; the student's own screen comes with students/enrollments.
export async function recordSubmission(
  tenant: TenantContext,
  _actor: AuthUser,
  homeworkId: bigint,
  input: RecordSubmissionInput,
): Promise<unknown> {
  const hw = await loadHomework(tenant.id, homeworkId);
  if (hw.status !== 'published') throw new HttpError(409, 'Submissions are accepted only while the homework is published');
  if (!hw.submissionRequired) throw new HttpError(400, 'This homework does not take submissions');

  // what the answer must contain depends on the homework's submission type
  const hasText = Boolean(input.textAnswer);
  const hasFile = input.fileId != null;
  if (hw.submissionType === 'text' && (!hasText || hasFile)) {
    throw new HttpError(400, 'This homework takes a text answer only');
  }
  if (hw.submissionType === 'file' && (!hasFile || hasText)) {
    throw new HttpError(400, 'This homework takes a file only');
  }
  if (hw.submissionType === 'both' && !hasText && !hasFile) {
    throw new HttpError(400, 'Send a text answer, a file, or both');
  }

  const submittedAt = input.submittedAt ? new Date(input.submittedAt) : new Date();
  const isLate = submittedAt > hw.dueAt;
  if (isLate && !hw.allowLate) {
    throw new HttpError(409, 'The due date has passed and late submissions are not allowed');
  }

  const [existing] = await db
    .select()
    .from(homeworkSubmissions)
    .where(
      and(
        eq(homeworkSubmissions.homeworkId, homeworkId),
        eq(homeworkSubmissions.enrollmentId, input.enrollmentId),
        eq(homeworkSubmissions.tenantId, tenant.id),
      ),
    )
    .limit(1);

  const answer = {
    textAnswer: input.textAnswer ?? null,
    fileId: input.fileId ?? null,
    submittedAt,
    status: isLate ? 'late' : 'submitted',
    lateReason: input.lateReason ?? null,
  };

  try {
    if (existing) {
      // only a missing submission or one sent back for resubmission can be replaced
      if (existing.status !== 'not_submitted' && !existing.resubmissionRequired) {
        throw new HttpError(409, 'A submission already exists for this student');
      }
      const [row] = await db
        .update(homeworkSubmissions)
        .set({
          ...answer,
          resubmissionRequired: false,
          score: null,
          gradeLabel: null,
          gradedBy: null,
          gradedAt: null,
          marksDeducted: null,
        })
        .where(eq(homeworkSubmissions.id, existing.id))
        .returning();
      return toRow(row);
    }
    const [row] = await db
      .insert(homeworkSubmissions)
      .values({ ...answer, tenantId: tenant.id, homeworkId, enrollmentId: input.enrollmentId })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A submission already exists for this student');
    throw e;
  }
}

// Grades a submission, or sends it back for resubmission.
export async function gradeSubmission(
  tenant: TenantContext,
  actor: AuthUser,
  submissionId: bigint,
  input: GradeSubmissionInput,
): Promise<unknown> {
  const [sub] = await db
    .select()
    .from(homeworkSubmissions)
    .where(and(eq(homeworkSubmissions.id, submissionId), eq(homeworkSubmissions.tenantId, tenant.id)))
    .limit(1);
  if (!sub) throw new HttpError(404, 'Submission not found');
  if (sub.status === 'not_submitted') throw new HttpError(409, 'Nothing has been submitted yet');

  const hw = await loadHomework(tenant.id, sub.homeworkId);

  if (input.resubmissionRequired) {
    const [row] = await db
      .update(homeworkSubmissions)
      .set({
        resubmissionRequired: true,
        feedback: input.feedback ?? sub.feedback,
        gradeLabel: input.gradeLabel ?? sub.gradeLabel,
      })
      .where(eq(homeworkSubmissions.id, submissionId))
      .returning();
    return toRow(row);
  }

  const score = input.score;
  if (score === undefined || score === null) throw new HttpError(400, 'score is required');
  if (hw.maxMarks !== null && score > Number(hw.maxMarks)) {
    throw new HttpError(400, `Score cannot be more than ${hw.maxMarks}`);
  }

  // late work loses latePenaltyPercent of the score; the score itself stays as the teacher gave it
  const wasLate = sub.submittedAt !== null && sub.submittedAt > hw.dueAt;
  const marksDeducted =
    wasLate && hw.latePenaltyPercent !== null
      ? (Math.round(score * Number(hw.latePenaltyPercent)) / 100).toFixed(2)
      : null;

  const [row] = await db
    .update(homeworkSubmissions)
    .set({
      status: 'graded',
      score: score.toFixed(2),
      gradeLabel: input.gradeLabel ?? null,
      feedback: input.feedback ?? null,
      gradedBy: await staffIdOfUser(tenant.id, actor.id),
      gradedAt: new Date(),
      resubmissionRequired: false,
      marksDeducted,
    })
    .where(eq(homeworkSubmissions.id, submissionId))
    .returning();
  return toRow(row);
}