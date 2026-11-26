import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { classes, homework, sectionTeachers, sections, staff, subjects } from '../../db/schema';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { resolveStudentScope } from '../../lib/ownership';
import { created, ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import type { AuthUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createHomeworkSchema, gradeSubmissionSchema } from '../homework/homework.schemas';
import * as svc from '../homework/homework.service';

// HOMEWORK PLUS: teacher + student friendly endpoints on top of the homework module.
// A student's id is used as the enrollment id of a submission (there is no enrollments table yet).

export const homeworkPlusRouter = Router();

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);
const isAdmin = (t: TenantContext) => t.permissions.has('*') || t.roles.includes('admin');

const colCache: Record<string, Set<string>> = {};
async function cols(table: string): Promise<Set<string>> {
  if (!colCache[table]) {
    const r = rowsOf(
      await db.execute(
        sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`,
      ),
    );
    colCache[table] = new Set(r.map((x: any) => String(x.column_name)));
  }
  return colCache[table];
}

async function myStaffId(tenantId: bigint, userId: bigint): Promise<bigint | null> {
  const [me] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.userId, userId), isNull(staff.deletedAt)))
    .limit(1);
  return me?.id ?? null;
}

async function loadHw(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(homework)
    .where(and(eq(homework.id, id), eq(homework.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Homework not found');
  return row;
}

async function assertCanManage(tenant: TenantContext, user: AuthUser, teacherId: bigint) {
  if (isAdmin(tenant)) return;
  const me = await myStaffId(tenant.id, user.id);
  if (me === null || me !== teacherId) throw new HttpError(403, 'This homework belongs to another teacher');
}

// ---------------------------------------------------------------- teacher
homeworkPlusRouter.get('/options', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const admin = isAdmin(tenant);
  const mine = admin ? null : await myStaffId(tenant.id, user.id);
  if (!admin && mine === null) return ok(res, []);
  const rows = await db
    .select({
      sectionId: sectionTeachers.sectionId,
      subjectId: sectionTeachers.subjectId,
      teacherId: sectionTeachers.teacherId,
      academicYearId: sectionTeachers.academicYearId,
      sectionName: sections.name,
      className: classes.name,
      subjectName: subjects.name,
    })
    .from(sectionTeachers)
    .innerJoin(sections, eq(sectionTeachers.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .innerJoin(subjects, eq(sectionTeachers.subjectId, subjects.id))
    .where(
      and(
        eq(sectionTeachers.tenantId, tenant.id),
        isNull(sections.deletedAt),
        admin ? undefined : eq(sectionTeachers.teacherId, mine as bigint),
      ),
    );
  ok(
    res,
    rows.map((r) => ({
      sectionId: String(r.sectionId),
      subjectId: String(r.subjectId),
      teacherId: String(r.teacherId),
      academicYearId: String(r.academicYearId),
      sectionName: r.sectionName,
      className: r.className,
      subjectName: r.subjectName,
    })),
  );
});

homeworkPlusRouter.get('/mine', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const admin = isAdmin(tenant);
  const mine = admin ? null : await myStaffId(tenant.id, user.id);
  if (!admin && mine === null) return ok(res, []);
  const secCond = (await cols('admissions')).has('section_id') ? sql`and a.section_id = h.section_id` : sql``;
  const who = admin ? sql`` : sql`and h.teacher_id = ${String(mine)}`;
  const r = rowsOf(
    await db.execute(sql`
      select h.id::text as "id", h.title as "title", h.due_at as "dueAt", h.status as "status",
             sec.name as "sectionName", c.name as "className", sub.name as "subjectName",
             (select count(*) from homework_submissions hs where hs.homework_id = h.id and hs.tenant_id = h.tenant_id and hs.status <> 'not_submitted') as "submitted",
             (select count(*) from homework_submissions hs where hs.homework_id = h.id and hs.tenant_id = h.tenant_id and hs.status = 'graded') as "graded",
             (select count(distinct a.student_id) from admissions a where a.tenant_id = h.tenant_id and a.class_id = sec.class_id and a.student_id is not null and a.deleted_at is null ${secCond}) as "total"
      from homework h
      join sections sec on sec.id = h.section_id
      join classes c on c.id = sec.class_id
      join subjects sub on sub.id = h.subject_id
      where h.tenant_id = ${String(tenant.id)} ${who}
      order by h.due_at desc, h.id desc
      limit 100`),
  );
  ok(
    res,
    r.map((x) => ({ ...x, submitted: Number(x.submitted), graded: Number(x.graded), total: Number(x.total) })),
  );
});

// create AND publish in one step
homeworkPlusRouter.post('/', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const parsed = createHomeworkSchema.parse(req.body);
  const input = isAdmin(tenant) ? parsed : { ...parsed, teacherId: undefined };
  const row: any = await svc.createHomework(tenant, user, input);
  try {
    const pub = await svc.publishHomework(tenant, BigInt(row.id));
    created(res, pub);
  } catch (e) {
    await svc.removeHomework(tenant, BigInt(row.id)).catch(() => undefined);
    throw e;
  }
});

homeworkPlusRouter.get('/:id/roster', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const id = parseId(req.params.id);
  const hw = await loadHw(tenant.id, id);
  await assertCanManage(tenant, user, hw.teacherId);

  const sc = await cols('students');
  const nameExpr = sc.has('full_name')
    ? sql`s.full_name`
    : sc.has('first_name')
      ? sc.has('last_name')
        ? sql`trim(concat_ws(' ', s.first_name, s.last_name))`
        : sql`s.first_name`
      : sql`('Student ' || s.id::text)`;
  const admNo = sc.has('admission_no') ? sql`s.admission_no` : sql`null`;
  const sDel = sc.has('deleted_at') ? sql`and s.deleted_at is null` : sql``;
  const secCond = (await cols('admissions')).has('section_id') ? sql`and a.section_id = h.section_id` : sql``;

  const head = rowsOf(
    await db.execute(sql`
      select h.id::text as "id", h.title as "title", h.description as "description", h.status as "status",
             h.due_at as "dueAt", h.max_marks::float8 as "maxMarks", h.allow_late as "allowLate",
             h.homework_type as "homeworkType",
             sec.name as "sectionName", c.name as "className", sub.name as "subjectName"
      from homework h
      join sections sec on sec.id = h.section_id
      join classes c on c.id = sec.class_id
      join subjects sub on sub.id = h.subject_id
      where h.id = ${String(id)} and h.tenant_id = ${String(tenant.id)}`),
  )[0];

  const students = rowsOf(
    await db.execute(sql`
      select distinct on (s.id)
             s.id::text as "studentId", ${nameExpr} as "name", ${admNo} as "admissionNo",
             hs.id::text as "submissionId", coalesce(hs.status, 'not_submitted') as "status",
             hs.text_answer as "textAnswer", hs.submitted_at as "submittedAt",
             hs.score::float8 as "score", hs.grade_label as "gradeLabel", hs.feedback as "feedback",
             coalesce(hs.resubmission_required, false) as "resubmissionRequired", hs.late_reason as "lateReason"
      from homework h
      join sections sec on sec.id = h.section_id
      join admissions a on a.tenant_id = h.tenant_id and a.class_id = sec.class_id and a.student_id is not null and a.deleted_at is null ${secCond}
      join students s on s.id = a.student_id ${sDel}
      left join homework_submissions hs on hs.homework_id = h.id and hs.enrollment_id = s.id and hs.tenant_id = h.tenant_id
      where h.id = ${String(id)} and h.tenant_id = ${String(tenant.id)}
      order by s.id`),
  );
  students.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  ok(res, { homework: head, students });
});

homeworkPlusRouter.post('/:id/close', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const id = parseId(req.params.id);
  const hw = await loadHw(tenant.id, id);
  await assertCanManage(tenant, currentUser(req), hw.teacherId);
  ok(res, await svc.closeHomework(tenant, id));
});

homeworkPlusRouter.post('/submissions/:id/grade', requirePermission('homework.create'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const subId = parseId(req.params.id);
  const r = rowsOf(
    await db.execute(sql`
      select h.teacher_id::text as "teacherId"
      from homework_submissions hs join homework h on h.id = hs.homework_id
      where hs.id = ${String(subId)} and hs.tenant_id = ${String(tenant.id)}`),
  )[0];
  if (!r) throw new HttpError(404, 'Submission not found');
  await assertCanManage(tenant, user, BigInt(r.teacherId));
  ok(res, await svc.gradeSubmission(tenant, user, subId, gradeSubmissionSchema.parse(req.body)));
});

// ---------------------------------------------------------------- student / parent
async function studentRows(tenantId: bigint, studentIds: bigint[], onlyId?: bigint) {
  if (studentIds.length === 0) return [];
  const secCond = (await cols('admissions')).has('section_id') ? sql`and a.section_id = h.section_id` : sql``;
  const ids = sql.join(studentIds.map((i) => sql`${String(i)}`), sql`, `);
  const only = onlyId ? sql`and h.id = ${String(onlyId)}` : sql``;
  return rowsOf(
    await db.execute(sql`
      select distinct on (h.id, a.student_id)
             h.id::text as "id", h.title as "title", h.description as "description",
             h.homework_type as "homeworkType", h.priority as "priority", h.due_at as "dueAt",
             h.max_marks::float8 as "maxMarks", h.status as "status",
             h.submission_required as "submissionRequired", h.allow_late as "allowLate",
             h.submission_type as "submissionType",
             sub.name as "subjectName", sec.name as "sectionName", c.name as "className",
             st.full_name as "teacherName", a.student_id::text as "studentId",
             coalesce(hs.status, 'not_submitted') as "subStatus", hs.score::float8 as "score",
             hs.grade_label as "gradeLabel", hs.feedback as "feedback",
             coalesce(hs.resubmission_required, false) as "resubmissionRequired",
             hs.text_answer as "textAnswer", hs.submitted_at as "submittedAt"
      from homework h
      join sections sec on sec.id = h.section_id
      join classes c on c.id = sec.class_id
      join subjects sub on sub.id = h.subject_id
      join staff st on st.id = h.teacher_id
      join admissions a on a.tenant_id = h.tenant_id and a.class_id = sec.class_id and a.deleted_at is null ${secCond}
                       and a.student_id in (${ids})
      left join homework_submissions hs on hs.homework_id = h.id and hs.enrollment_id = a.student_id and hs.tenant_id = h.tenant_id
      where h.tenant_id = ${String(tenantId)} and h.status in ('published', 'closed') ${only}
      order by h.id, a.student_id`),
  );
}

homeworkPlusRouter.get('/my', requirePermission('homework.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const scope = await resolveStudentScope(tenant, currentUser(req).id, 'homework.view');
  if (!scope.scoped || scope.studentIds.length === 0) return ok(res, []);
  const rows = await studentRows(tenant.id, scope.studentIds);
  rows.sort((a, b) => new Date(b.dueAt).getTime() - new Date(a.dueAt).getTime());
  ok(res, rows.slice(0, 150));
});

const submitSchema = z
  .object({ studentId: z.coerce.bigint().optional(), textAnswer: z.string().trim().min(1).max(10000) })
  .strict();

homeworkPlusRouter.post('/:id/submit', requirePermission('homework.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const id = parseId(req.params.id);
  const input = submitSchema.parse(req.body);
  const scope = await resolveStudentScope(tenant, user.id, 'homework.view');
  if (!scope.scoped || scope.studentIds.length === 0) throw new HttpError(403, 'Only students can submit homework');
  const studentId = input.studentId ?? scope.studentIds[0];
  if (!scope.studentIds.some((s) => String(s) === String(studentId))) throw new HttpError(403, 'Not your student');
  const mine = await studentRows(tenant.id, [studentId], id);
  if (mine.length === 0) throw new HttpError(404, 'Homework not found for your class');
  ok(res, await svc.recordSubmission(tenant, user, id, { enrollmentId: studentId, textAnswer: input.textAnswer } as any));
});