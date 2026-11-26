import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  admissions,
  classes,
  guardians,
  periodAttendance,
  sections,
  staff,
  studentGuardians,
  students,
  subjects,
  timeSlots,
  timetableEntries,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { schoolToday } from '../../lib/schoolDate';
import { assertStudentReadable, resolveStudentScope, studentScopeCondition } from '../../lib/ownership';
import { hasPermission, type TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { notifyUsers, type NewNotification } from '../notifications/notifications.service';
import type {
  ListAttendanceInput,
  ListPeriodsInput,
  SaveSheetInput,
  SheetQueryInput,
  SummaryInput,
} from './periodAttendance.schemas';

// RULES: every query has tenantId = tenant.id.
// One row = one student, in one period (a timetable entry), on one date.
// A student belongs to a class through their admission (admissions.studentId + classId), so the class list
// of a period is every active student of the period's class.

const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

// 1 (Mon) - 7 (Sun), same as timetable_entries.day_of_week
const weekdayOf = (date: string) => {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
};

async function myStaffId(tenant: TenantContext, actor: AuthUser): Promise<bigint | null> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.userId, actor.id), isNull(staff.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

const canMarkAny = (tenant: TenantContext) => hasPermission(tenant, 'attendance.manage');

const entryColumns = () => ({
  id: timetableEntries.id,
  dayOfWeek: timetableEntries.dayOfWeek,
  teacherId: staff.id, // same value as timetable_entries.teacher_id; typed non-null because staff is INNER joined (a lesson without a teacher is not a period you can mark)
  teacherName: staff.fullName,
  sectionId: timetableEntries.sectionId,
  sectionName: sections.name,
  classId: classes.id,
  className: classes.name,
  gradeLevel: classes.gradeLevel,
  subjectId: subjects.id,
  subjectName: subjects.name,
  timeSlotId: timeSlots.id,
  slotName: timeSlots.name,
  slotSequence: timeSlots.sequence,
  startsAt: timeSlots.startsAt,
  endsAt: timeSlots.endsAt,
});

// Subjects and staff are INNER joined on purpose: activities without a subject or teacher (planner rows such as
// Library/Assembly) are not periods you can mark: period_attendance.subject_id and teacher_id are NOT NULL;
// a future change would need a migration.
const entryFrom = () =>
  db
    .select(entryColumns())
    .from(timetableEntries)
    .innerJoin(sections, eq(timetableEntries.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .innerJoin(subjects, eq(timetableEntries.subjectId, subjects.id))
    .innerJoin(timeSlots, eq(timetableEntries.timeSlotId, timeSlots.id))
    .innerJoin(staff, eq(timetableEntries.teacherId, staff.id));

const slotRunsOnEntryDay = sql`${timetableEntries.dayOfWeek} = ANY(${timeSlots.days})`;

// The period must exist, run on that weekday, be in effect on that date and not be in the future,
// and the caller must be its teacher (or have attendance.manage).
async function loadEntryFor(tenant: TenantContext, actor: AuthUser, entryId: bigint, date: string) {
  const [entry] = await entryFrom()
    .where(and(
      eq(timetableEntries.id, entryId),
      eq(timetableEntries.tenantId, tenant.id),
      eq(timetableEntries.status, 'active'),
      eq(timeSlots.isBreak, false),
      slotRunsOnEntryDay,
    ))
    .limit(1);
  if (!entry) throw new HttpError(404, 'Period not found');

  const [range] = await db
    .select({ from: timetableEntries.effectiveFrom, to: timetableEntries.effectiveTo })
    .from(timetableEntries)
    .where(eq(timetableEntries.id, entryId))
    .limit(1);
  if (date < range.from || (range.to && date > range.to)) {
    throw new HttpError(400, 'This period is not in the timetable on that date');
  }
  if (weekdayOf(date) !== entry.dayOfWeek) {
    throw new HttpError(400, 'This period does not run on that day of the week');
  }
  if (date > (await schoolToday(tenant))) {
    throw new HttpError(400, 'Attendance cannot be marked for a future date');
  }

  if (!canMarkAny(tenant)) {
    const me = await myStaffId(tenant, actor);
    if (me === null || me !== entry.teacherId) {
      throw new HttpError(403, 'Only the teacher of this period can mark its attendance');
    }
  }
  return entry;
}

// Active students of a class, in name order.
async function rosterOf(tenant: TenantContext, classId: bigint) {
  const rows = await db
    .select({
      id: students.id,
      admissionNo: students.admissionNo,
      fullName: students.fullName,
      firstName: students.firstName,
      lastName: students.lastName,
      photoFileId: students.photoFileId,
    })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(admissions.tenantId, tenant.id),
        eq(admissions.classId, classId),
        isNull(admissions.deletedAt),
        eq(students.tenantId, tenant.id),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    )
    .orderBy(asc(students.fullName), asc(students.firstName), asc(students.id));
  const seen = new Set<string>();
  return rows
    .filter((r) => (seen.has(String(r.id)) ? false : (seen.add(String(r.id)), true)))
    .map((r) => ({ ...r, fullName: r.fullName || [r.firstName, r.lastName].filter(Boolean).join(' ') }));
}

// ---------------------------------------------------------------- the periods of a day
export async function listPeriods(tenant: TenantContext, actor: AuthUser, q: ListPeriodsInput) {
  const date = q.date ?? (await schoolToday(tenant));

  let teacherCond;
  if (!canMarkAny(tenant)) {
    const me = await myStaffId(tenant, actor);
    if (me === null) return { date, periods: [] as unknown[] };
    teacherCond = eq(timetableEntries.teacherId, me);
  }

  const entries = await entryFrom()
    .where(
      and(
        eq(timetableEntries.tenantId, tenant.id),
        eq(timetableEntries.status, 'active'),
        eq(timetableEntries.dayOfWeek, weekdayOf(date)),
        lte(timetableEntries.effectiveFrom, date),
        or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, date)),
        eq(timeSlots.isBreak, false),
        slotRunsOnEntryDay,
        teacherCond,
        q.classId ? eq(classes.id, q.classId) : undefined,
      ),
    )
    .orderBy(asc(classes.gradeLevel), asc(classes.name), asc(timeSlots.startsAt), asc(timeSlots.sequence));

  if (entries.length === 0) return { date, periods: [] as unknown[] };

  const entryIds = entries.map((e) => e.id);
  const classIds = [...new Set(entries.map((e) => e.classId))];

  const [marked, sizes] = await Promise.all([
    db
      .select({ entryId: periodAttendance.timetableEntryId, status: periodAttendance.status, n: count() })
      .from(periodAttendance)
      .where(
        and(
          eq(periodAttendance.tenantId, tenant.id),
          eq(periodAttendance.attendanceDate, date),
          inArray(periodAttendance.timetableEntryId, entryIds),
        ),
      )
      .groupBy(periodAttendance.timetableEntryId, periodAttendance.status),
    db
      .select({ classId: admissions.classId, n: sql<number>`count(distinct ${students.id})::int` })
      .from(admissions)
      .innerJoin(students, eq(admissions.studentId, students.id))
      .where(
        and(
          eq(admissions.tenantId, tenant.id),
          inArray(admissions.classId, classIds),
          isNull(admissions.deletedAt),
          isNull(students.deletedAt),
          eq(students.status, 'active'),
        ),
      )
      .groupBy(admissions.classId),
  ]);

  const counts = new Map<string, Record<string, number>>();
  for (const m of marked) {
    const k = String(m.entryId);
    counts.set(k, { ...(counts.get(k) ?? {}), [m.status]: Number(m.n) });
  }
  const size = new Map(sizes.map((s) => [String(s.classId), Number(s.n)]));

  return {
    date,
    periods: entries.map((e) => {
      const c = counts.get(String(e.id)) ?? {};
      const markedCount = Object.values(c).reduce((a, b) => a + b, 0);
      return {
        ...e,
        studentCount: size.get(String(e.classId)) ?? 0,
        markedCount,
        taken: markedCount > 0,
        present: c.present ?? 0,
        absent: c.absent ?? 0,
        late: c.late ?? 0,
        excused: c.excused ?? 0,
      };
    }),
  };
}

// ---------------------------------------------------------------- mark one period
export async function getSheet(tenant: TenantContext, actor: AuthUser, q: SheetQueryInput) {
  const entry = await loadEntryFor(tenant, actor, q.timetableEntryId, q.date);
  const [roster, existing] = await Promise.all([
    rosterOf(tenant, entry.classId),
    db
      .select({ studentId: periodAttendance.studentId, status: periodAttendance.status, remarks: periodAttendance.remarks })
      .from(periodAttendance)
      .where(
        and(
          eq(periodAttendance.tenantId, tenant.id),
          eq(periodAttendance.attendanceDate, q.date),
          eq(periodAttendance.timetableEntryId, q.timetableEntryId),
        ),
      ),
  ]);
  const byStudent = new Map(existing.map((e) => [String(e.studentId), e]));

  return {
    date: q.date,
    period: entry,
    markedCount: existing.length,
    students: roster.map((s) => ({
      ...s,
      status: byStudent.get(String(s.id))?.status ?? null,
      remarks: byStudent.get(String(s.id))?.remarks ?? null,
    })),
  };
}

// Tell the student (and their parents) when a student is newly marked absent, present or late in a period.
// Never throws: a failed notification must not stop the attendance from being saved.
type NotifyStatus = 'absent' | 'present' | 'late';
const NOTIFY_TEXT: Record<NotifyStatus, { own: string; child: string; verb: string }> = {
  absent: { own: 'Marked absent', child: 'Child marked absent', verb: 'absent' },
  present: { own: 'Marked present', child: 'Child marked present', verb: 'present' },
  late: { own: 'Marked late', child: 'Child marked late', verb: 'late' },
};

async function notifyStatus(
  tenant: TenantContext,
  entry: { id: bigint; subjectName: string; slotName: string; startsAt: string; endsAt: string },
  date: string,
  studentIds: bigint[],
  status: NotifyStatus,
) {
  if (studentIds.length === 0) return;
  try {
    const kids = await db
      .select({ id: students.id, userId: students.userId, fullName: students.fullName, firstName: students.firstName, lastName: students.lastName })
      .from(students)
      .where(and(eq(students.tenantId, tenant.id), inArray(students.id, studentIds)));
    const parents = await db
      .select({ studentId: studentGuardians.studentId, userId: guardians.userId })
      .from(studentGuardians)
      .innerJoin(guardians, eq(studentGuardians.guardianId, guardians.id))
      .where(and(eq(studentGuardians.tenantId, tenant.id), inArray(studentGuardians.studentId, studentIds), isNull(guardians.deletedAt)));

    const day = new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    const when = `${entry.subjectName}, ${entry.slotName} (${entry.startsAt.slice(0, 5)}-${entry.endsAt.slice(0, 5)}) on ${day}`;

    const text = NOTIFY_TEXT[status];
    const items: NewNotification[] = [];
    const seen = new Set<string>();
    const add = (userId: bigint | null, studentId: bigint, title: string, body: string) => {
      if (userId === null) return;
      const key = `${userId}:${studentId}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        userId,
        type: `attendance_${status}`,
        title,
        body,
        data: { studentId: String(studentId), date, timetableEntryId: String(entry.id), status },
      });
    };

    for (const k of kids) {
      const name = k.fullName || [k.firstName, k.lastName].filter(Boolean).join(' ');
      add(k.userId, k.id, text.own, `You were marked ${text.verb} in ${when}.`);
      for (const p of parents.filter((x) => x.studentId === k.id)) {
        add(p.userId, k.id, text.child, `${name} was marked ${text.verb} in ${when}.`);
      }
    }
    await notifyUsers(tenant.id, items);
  } catch (e) {
    logger.error({ err: e }, 'could not create attendance notifications');
  }
}

export async function saveSheet(tenant: TenantContext, actor: AuthUser, input: SaveSheetInput) {
  const entry = await loadEntryFor(tenant, actor, input.timetableEntryId, input.date);
  const roster = await rosterOf(tenant, entry.classId);
  const allowed = new Set(roster.map((s) => String(s.id)));

  const seen = new Set<string>();
  for (const m of input.marks) {
    const sid = String(m.studentId);
    if (!allowed.has(sid)) throw new HttpError(400, `Student ${sid} is not in ${entry.className}`);
    if (seen.has(sid)) throw new HttpError(400, `Student ${sid} is listed twice`);
    seen.add(sid);
  }

  // who was already absent in this period, so a re-save does not notify twice
  const before = await db
    .select({ studentId: periodAttendance.studentId, status: periodAttendance.status })
    .from(periodAttendance)
    .where(
      and(
        eq(periodAttendance.tenantId, tenant.id),
        eq(periodAttendance.attendanceDate, input.date),
        eq(periodAttendance.timetableEntryId, entry.id),
      ),
    );
  const previous = new Map(before.map((r) => [String(r.studentId), r.status]));

  await db.transaction(async (tx) => {
    for (const m of input.marks) {
      await tx
        .insert(periodAttendance)
        .values({
          tenantId: tenant.id,
          attendanceDate: input.date,
          timetableEntryId: entry.id,
          classId: entry.classId,
          timeSlotId: entry.timeSlotId,
          subjectId: entry.subjectId,
          teacherId: entry.teacherId,
          studentId: m.studentId,
          status: m.status,
          remarks: m.remarks ?? null,
          markedBy: actor.id,
        })
        .onConflictDoUpdate({
          target: [periodAttendance.tenantId, periodAttendance.attendanceDate, periodAttendance.timetableEntryId, periodAttendance.studentId],
          set: { status: m.status, remarks: m.remarks ?? null, markedBy: actor.id, markedAt: sql`CURRENT_TIMESTAMP` },
        });
    }
  });

  // only students whose status actually changed (a re-save with no change sends nothing)
  const changed = (status: NotifyStatus) =>
    input.marks
      .filter((m) => m.status === status && previous.get(String(m.studentId)) !== status)
      .map((m) => m.studentId);
  await notifyStatus(tenant, entry, input.date, changed('absent'), 'absent');
  await notifyStatus(tenant, entry, input.date, changed('present'), 'present');
  await notifyStatus(tenant, entry, input.date, changed('late'), 'late');

  return getSheet(tenant, actor, { timetableEntryId: input.timetableEntryId, date: input.date });
}

// ---------------------------------------------------------------- history (row-scoped for students/parents)
export async function listAttendance(tenant: TenantContext, actor: AuthUser, q: ListAttendanceInput) {
  const scope = await resolveStudentScope(tenant, actor.id, 'attendance.view');
  const scopeCond = studentScopeCondition(periodAttendance.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const where = and(
    eq(periodAttendance.tenantId, tenant.id),
    scopeCond,
    q.studentId ? eq(periodAttendance.studentId, q.studentId) : undefined,
    q.classId ? eq(periodAttendance.classId, q.classId) : undefined,
    q.subjectId ? eq(periodAttendance.subjectId, q.subjectId) : undefined,
    q.timetableEntryId ? eq(periodAttendance.timetableEntryId, q.timetableEntryId) : undefined,
    q.status ? eq(periodAttendance.status, q.status) : undefined,
    q.dateFrom ? gte(periodAttendance.attendanceDate, q.dateFrom) : undefined,
    q.dateTo ? lte(periodAttendance.attendanceDate, q.dateTo) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: periodAttendance.id,
        attendanceDate: periodAttendance.attendanceDate,
        status: periodAttendance.status,
        remarks: periodAttendance.remarks,
        studentId: periodAttendance.studentId,
        studentName: students.fullName,
        admissionNo: students.admissionNo,
        classId: periodAttendance.classId,
        className: classes.name,
        subjectName: subjects.name,
        slotName: timeSlots.name,
        slotSequence: timeSlots.sequence,
        startsAt: timeSlots.startsAt,
        endsAt: timeSlots.endsAt,
        teacherName: staff.fullName,
      })
      .from(periodAttendance)
      .innerJoin(students, eq(periodAttendance.studentId, students.id))
      .innerJoin(classes, eq(periodAttendance.classId, classes.id))
      .innerJoin(subjects, eq(periodAttendance.subjectId, subjects.id))
      .innerJoin(timeSlots, eq(periodAttendance.timeSlotId, timeSlots.id))
      .innerJoin(staff, eq(periodAttendance.teacherId, staff.id))
      .where(where)
      .orderBy(desc(periodAttendance.attendanceDate), asc(timeSlots.sequence), asc(students.fullName))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(periodAttendance).where(where),
  ]);

  return { rows, meta: pageMeta(q.page, q.limit, total) };
}

// Totals and percentage for one student, overall and per subject.
// "Attended" counts present + late (a late student was in the class); excused periods are left out of the percentage.
export async function summary(tenant: TenantContext, actor: AuthUser, q: SummaryInput) {
  const scope = await resolveStudentScope(tenant, actor.id, 'attendance.view');
  assertStudentReadable(scope, q.studentId, 'Student not found');

  const rows = await db
    .select({ subjectId: subjects.id, subjectName: subjects.name, status: periodAttendance.status, n: count() })
    .from(periodAttendance)
    .innerJoin(subjects, eq(periodAttendance.subjectId, subjects.id))
    .where(
      and(
        eq(periodAttendance.tenantId, tenant.id),
        eq(periodAttendance.studentId, q.studentId),
        q.dateFrom ? gte(periodAttendance.attendanceDate, q.dateFrom) : undefined,
        q.dateTo ? lte(periodAttendance.attendanceDate, q.dateTo) : undefined,
      ),
    )
    .groupBy(subjects.id, subjects.name, periodAttendance.status);

  const blank = () => ({ present: 0, absent: 0, late: 0, excused: 0 }) as Record<string, number>;
  const percent = (c: Record<string, number>) => {
    const counted = c.present + c.absent + c.late;
    return counted === 0 ? null : Math.round(((c.present + c.late) / counted) * 1000) / 10;
  };

  const total = blank();
  const bySubject = new Map<string, { subjectId: bigint; subjectName: string; counts: Record<string, number> }>();
  for (const r of rows) {
    const n = Number(r.n);
    total[r.status] = (total[r.status] ?? 0) + n;
    const k = String(r.subjectId);
    const entry = bySubject.get(k) ?? { subjectId: r.subjectId, subjectName: r.subjectName, counts: blank() };
    entry.counts[r.status] = (entry.counts[r.status] ?? 0) + n;
    bySubject.set(k, entry);
  }

  return {
    studentId: q.studentId,
    periods: total.present + total.absent + total.late + total.excused,
    ...total,
    percent: percent(total),
    bySubject: [...bySubject.values()]
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
      .map((s) => ({
        subjectId: s.subjectId,
        subjectName: s.subjectName,
        ...s.counts,
        periods: s.counts.present + s.counts.absent + s.counts.late + s.counts.excused,
        percent: percent(s.counts),
      })),
  };
}