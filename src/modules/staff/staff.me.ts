import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  classes,
  classrooms,
  homework,
  sectionTeachers,
  sections,
  staff,
  subjects,
  timeSlots,
  timetableEntries,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { schoolToday } from '../../lib/schoolDate';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { resolveAcademicYearId } from '../academic-years/academicYears.service';

// The staff row that belongs to the signed-in login. The "me" functions below are scoped to it.
async function myStaffId(tenant: TenantContext, actor: AuthUser): Promise<bigint> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.userId, actor.id), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'No staff record is linked to this login');
  return row.id;
}

// Used by the admin-facing "by id" functions: the teacher must exist in THIS school.
async function assertStaff(tenant: TenantContext, id: bigint): Promise<bigint> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.id, id), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Staff member not found');
  return row.id;
}

// ---- shared queries (take a staff id) ----------------------------------------------------

// Weekly timetable, Monday first. Only entries that are active today.
async function timetableFor(tenant: TenantContext, teacherId: bigint) {
  const [today, yearId] = await Promise.all([schoolToday(tenant), resolveAcademicYearId(tenant)]);

  const rows = await db
    .select({
      id: timetableEntries.id,
      dayOfWeek: timetableEntries.dayOfWeek,
      sectionId: timetableEntries.sectionId,
      sectionName: sections.name,
      className: classes.name,
      subjectId: timetableEntries.subjectId,
      title: timetableEntries.title,
      source: timetableEntries.source,
      subject: getTableColumns(subjects), // all null for a planner row that has no subject
      timeSlot: getTableColumns(timeSlots),
      classroomId: timetableEntries.classroomId,
      classroom: getTableColumns(classrooms),
    })
    .from(timetableEntries)
    .innerJoin(sections, eq(timetableEntries.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .leftJoin(subjects, eq(timetableEntries.subjectId, subjects.id))
    .innerJoin(timeSlots, eq(timetableEntries.timeSlotId, timeSlots.id))
    .leftJoin(classrooms, eq(timetableEntries.classroomId, classrooms.id))
    .where(
      and(
        eq(timetableEntries.tenantId, tenant.id),
        eq(timetableEntries.teacherId, teacherId),
        eq(timetableEntries.status, 'active'),
        eq(timetableEntries.academicYearId, yearId),
        eq(timeSlots.isActive, true),
        sql`${timetableEntries.dayOfWeek} = ANY(${timeSlots.days})`,
        lte(timetableEntries.effectiveFrom, today),
        or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, today)),
      ),
    )
    .orderBy(asc(timetableEntries.dayOfWeek), asc(timeSlots.startsAt), asc(timeSlots.sequence), asc(timetableEntries.id));

  // no subject row (planner lesson with only a title): hand back the title as the subject's name so the page still has a label
  return {
    today,
    rows: rows.map((r) => ({
      ...r,
      subject: r.subject ?? (r.title ? { name: r.title } : null),
    })),
  };
}

// "This teacher takes this subject in this section" (the mapping saved when a teacher is added).
async function assignmentsFor(tenant: TenantContext, teacherId: bigint, academicYearId?: bigint) {
  return db
    .select({
      id: sectionTeachers.id,
      academicYearId: sectionTeachers.academicYearId,
      sectionId: sectionTeachers.sectionId,
      sectionName: sections.name,
      classId: classes.id,
      className: classes.name,
      subject: { id: subjects.id, name: subjects.name, code: subjects.code },
    })
    .from(sectionTeachers)
    .innerJoin(sections, eq(sectionTeachers.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .innerJoin(subjects, eq(sectionTeachers.subjectId, subjects.id))
    .where(and(
      eq(sectionTeachers.tenantId, tenant.id),
      eq(sectionTeachers.teacherId, teacherId),
      academicYearId === undefined ? undefined : eq(sectionTeachers.academicYearId, academicYearId),
    ))
    .orderBy(asc(classes.name), asc(sections.name), asc(subjects.name));
}

// ---- the signed-in teacher's own data ---------------------------------------------------

// Sections this teacher teaches (taken from their timetable).
export async function getMySections(tenant: TenantContext, actor: AuthUser) {
  const teacherId = await myStaffId(tenant, actor);

  const mySectionIds = db
    .select({ id: timetableEntries.sectionId })
    .from(timetableEntries)
    .where(
      and(
        eq(timetableEntries.tenantId, tenant.id),
        eq(timetableEntries.teacherId, teacherId),
        eq(timetableEntries.status, 'active'),
      ),
    );

  return db
    .select({
      id: sections.id,
      name: sections.name,
      classId: sections.classId,
      className: classes.name,
      capacity: sections.capacity,
      shift: sections.shift,
      medium: sections.medium,
    })
    .from(sections)
    .innerJoin(classes, eq(sections.classId, classes.id))
    .where(and(eq(sections.tenantId, tenant.id), isNull(sections.deletedAt), inArray(sections.id, mySectionIds)))
    .orderBy(asc(classes.name), asc(sections.name));
}

export async function getMyTimetable(tenant: TenantContext, actor: AuthUser) {
  return timetableFor(tenant, await myStaffId(tenant, actor));
}

export async function getMyAssignments(tenant: TenantContext, actor: AuthUser) {
  const teacherId = await myStaffId(tenant, actor);
  return assignmentsFor(tenant, teacherId, await resolveAcademicYearId(tenant));
}

// Homework this teacher has set, newest due date first.
export async function getMyHomework(tenant: TenantContext, actor: AuthUser) {
  const teacherId = await myStaffId(tenant, actor);

  return db
    .select({
      id: homework.id,
      homeworkCode: homework.homeworkCode,
      title: homework.title,
      description: homework.description,
      homeworkType: homework.homeworkType,
      priority: homework.priority,
      assignedOn: homework.assignedOn,
      dueAt: homework.dueAt,
      maxMarks: homework.maxMarks,
      status: homework.status,
      sectionId: homework.sectionId,
      sectionName: sections.name,
      className: classes.name,
      subject: getTableColumns(subjects),
    })
    .from(homework)
    .innerJoin(sections, eq(homework.sectionId, sections.id))
    .innerJoin(classes, eq(sections.classId, classes.id))
    .innerJoin(subjects, eq(homework.subjectId, subjects.id))
    .where(and(eq(homework.tenantId, tenant.id), eq(homework.teacherId, teacherId)))
    .orderBy(desc(homework.dueAt))
    .limit(100);
}

// ---- any teacher, by id (for the admin's Teacher Details page; the route checks staff.view) ----

export async function getStaffTimetable(tenant: TenantContext, id: bigint) {
  return timetableFor(tenant, await assertStaff(tenant, id));
}

export async function getStaffAssignments(tenant: TenantContext, id: bigint, academicYearId?: bigint) {
  return assignmentsFor(tenant, await assertStaff(tenant, id), academicYearId);
}
