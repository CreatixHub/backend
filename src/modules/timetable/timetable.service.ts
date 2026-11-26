import { and, asc, count, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  classes,
  classrooms,
  classSubjects,
  sections,
  sectionTeachers,
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
import type {
  CreateEntryInput,
  CreateSectionTeacherInput,
  CreateTimeSlotInput,
  ListEntriesInput,
  ListSectionTeachersInput,
  ListTimeSlotsInput,
  UpdateEntryInput,
  UpdateSectionTeacherInput,
  UpdateTimeSlotInput,
} from './timetable.schemas';
import { DEFAULT_DAY_TYPE, DEFAULT_DAYS, slotsConflict, toMinutes } from './slotOverlap';

// RULES (same as the other modules): every query has tenantId = tenant.id.

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

// The subject must be one of the subjects the section's class teaches (class_subjects).
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

async function assertClassroom(tenantId: bigint, classroomId: bigint) {
  const [row] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(
      and(
        eq(classrooms.id, classroomId),
        eq(classrooms.tenantId, tenantId),
        isNull(classrooms.deletedAt),
        eq(classrooms.status, 'active'),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(400, 'Classroom not found in this school');
}

// ================================================================ TIME SLOTS
const SEQUENCE_TAKEN = 'A time slot with that sequence number already exists';

async function loadTimeSlot(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(timeSlots)
    .where(and(eq(timeSlots.id, id), eq(timeSlots.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Time slot not found');
  return row;
}

// Two periods that share a weekday cannot overlap in time (a Friday-only bell may overlap a Mon-Thu bell).
// The decision itself lives in the pure slotsConflict(); a school has only a few dozen slots, so we load them
// (this tenant only) and ask that one function instead of repeating the rule in SQL.
async function assertNoSlotOverlap(
  tenantId: bigint,
  window: { startsAt: string; endsAt: string; days: readonly number[] },
  selfId?: bigint,
) {
  const others = await db
    .select({ name: timeSlots.name, startsAt: timeSlots.startsAt, endsAt: timeSlots.endsAt, days: timeSlots.days })
    .from(timeSlots)
    .where(and(eq(timeSlots.tenantId, tenantId), selfId === undefined ? undefined : ne(timeSlots.id, selfId)));
  const clash = others.find((other) => slotsConflict(window, other));
  if (clash) throw new HttpError(409, `These times overlap with "${clash.name}"`);
}

async function countEntriesUsingSlot(tenantId: bigint, timeSlotId: bigint, activeOnly: boolean): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(timetableEntries)
    .where(
      and(
        eq(timetableEntries.tenantId, tenantId),
        eq(timetableEntries.timeSlotId, timeSlotId),
        activeOnly ? eq(timetableEntries.status, 'active') : undefined,
      ),
    );
  return total;
}

// 1 = Monday ... 7 = Sunday (same numbering as timetable_entries.day_of_week and time_slots.days)
const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

// Active lessons of this slot (any academic year) that fall on one of these weekdays.
async function countActiveEntriesOnDays(tenantId: bigint, timeSlotId: bigint, days: number[]): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(timetableEntries)
    .where(
      and(
        eq(timetableEntries.tenantId, tenantId),
        eq(timetableEntries.timeSlotId, timeSlotId),
        eq(timetableEntries.status, 'active'),
        inArray(timetableEntries.dayOfWeek, days),
      ),
    );
  return total;
}

export async function listTimeSlots(tenant: TenantContext, q: ListTimeSlotsInput): Promise<unknown> {
  const rows = await db
    .select()
    .from(timeSlots)
    .where(
      and(
        eq(timeSlots.tenantId, tenant.id),
        q.isActive === undefined ? undefined : eq(timeSlots.isActive, q.isActive),
        q.dayType === undefined ? undefined : eq(timeSlots.dayType, q.dayType),
      ),
    )
    .orderBy(asc(timeSlots.sequence), asc(timeSlots.dayType), asc(timeSlots.id));
  return rows.map(toRow);
}

const sortedDays = (days: readonly number[]) => [...days].sort((a, b) => a - b);

export async function createTimeSlot(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateTimeSlotInput,
): Promise<unknown> {
  const days = sortedDays(input.days ?? DEFAULT_DAYS);
  await assertNoSlotOverlap(tenant.id, { startsAt: input.startsAt, endsAt: input.endsAt, days });
  try {
    const [row] = await db
      .insert(timeSlots)
      .values({
        ...input,
        dayType: input.dayType ?? DEFAULT_DAY_TYPE,
        days,
        tenantId: tenant.id,
        durationMinutes: toMinutes(input.endsAt) - toMinutes(input.startsAt),
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEQUENCE_TAKEN);
    throw e;
  }
}

export async function updateTimeSlot(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateTimeSlotInput,
): Promise<unknown> {
  const existing = await loadTimeSlot(tenant.id, id);
  const startsAt = input.startsAt ?? existing.startsAt;
  const endsAt = input.endsAt ?? existing.endsAt;
  if (toMinutes(endsAt) <= toMinutes(startsAt)) {
    throw new HttpError(400, 'Validation failed', [{ field: 'endsAt', message: 'Must be after startsAt' }]);
  }
  const days = input.days === undefined ? existing.days : sortedDays(input.days);
  // overlap is checked against the NEW times and days; a changed dayType/sequence is checked by the unique index below
  await assertNoSlotOverlap(tenant.id, { startsAt, endsAt, days }, id);

  // turning a slot into a break (or switching it off) is not allowed while lessons use it
  if (input.isBreak === true || input.isActive === false) {
    if ((await countEntriesUsingSlot(tenant.id, id, true)) > 0) {
      throw new HttpError(409, 'Remove the lessons in this time slot first');
    }
  }

  // dropping a weekday from the slot is not allowed while active lessons (any academic year) still run on it:
  // they would silently vanish from every timetable view and could not be marked in period attendance
  if (input.days !== undefined) {
    const removed = existing.days.filter((day) => !days.includes(day));
    if (removed.length > 0 && (await countActiveEntriesOnDays(tenant.id, id, removed)) > 0) {
      const names = removed.map((day) => WEEKDAY_NAMES[day] ?? `day ${day}`).join(', ');
      throw new HttpError(409, `Remove or move the lessons on ${names} that use this time slot first`);
    }
  }

  try {
    const [row] = await db
      .update(timeSlots)
      .set({ ...input, ...(input.days === undefined ? {} : { days }), durationMinutes: toMinutes(endsAt) - toMinutes(startsAt) })
      .where(and(eq(timeSlots.id, id), eq(timeSlots.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEQUENCE_TAKEN);
    throw e;
  }
}

// Real delete (the spec has no soft-delete column here), allowed only while no timetable entry uses the slot.
export async function removeTimeSlot(tenant: TenantContext, id: bigint): Promise<void> {
  await loadTimeSlot(tenant.id, id);
  if ((await countEntriesUsingSlot(tenant.id, id, false)) > 0) {
    throw new HttpError(409, 'This time slot is used in the timetable');
  }
  await db.delete(timeSlots).where(and(eq(timeSlots.id, id), eq(timeSlots.tenantId, tenant.id)));
}

// ================================================================ SECTION TEACHERS
const ASSIGNMENT_TAKEN = 'This section already has a teacher for that subject in this academic year';

async function loadAssignment(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(sectionTeachers)
    .where(and(eq(sectionTeachers.id, id), eq(sectionTeachers.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Assignment not found');
  return row;
}

export async function listSectionTeachers(tenant: TenantContext, q: ListSectionTeachersInput): Promise<Page> {
  const where = and(
    eq(sectionTeachers.tenantId, tenant.id),
    q.sectionId ? eq(sectionTeachers.sectionId, q.sectionId) : undefined,
    q.teacherId ? eq(sectionTeachers.teacherId, q.teacherId) : undefined,
    q.academicYearId ? eq(sectionTeachers.academicYearId, q.academicYearId) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: sectionTeachers.id,
        sectionId: sectionTeachers.sectionId,
        sectionName: sections.name,
        className: classes.name,
        subjectId: sectionTeachers.subjectId,
        subjectName: subjects.name,
        academicYearId: sectionTeachers.academicYearId,
        teacherId: sectionTeachers.teacherId,
        teacherName: staff.fullName,
      })
      .from(sectionTeachers)
      .innerJoin(sections, eq(sectionTeachers.sectionId, sections.id))
      .innerJoin(classes, eq(sections.classId, classes.id))
      .innerJoin(subjects, eq(sectionTeachers.subjectId, subjects.id))
      .innerJoin(staff, eq(sectionTeachers.teacherId, staff.id))
      .where(where)
      .orderBy(asc(classes.gradeLevel), asc(sections.name), asc(subjects.name))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(sectionTeachers).where(where),
  ]);

  return { rows, meta: pageMeta(q.page, q.limit, total) };
}

export async function createSectionTeacher(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateSectionTeacherInput,
): Promise<unknown> {
  const section = await loadSection(tenant.id, input.sectionId);
  await assertSubjectTaughtInClass(tenant.id, section.classId, input.subjectId);
  await assertTeacher(tenant.id, input.teacherId);
  const academicYearId = await resolveAcademicYearId(tenant, input.academicYearId);
  try {
    const [row] = await db
      .insert(sectionTeachers)
      .values({ ...input, tenantId: tenant.id, academicYearId })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, ASSIGNMENT_TAKEN);
    throw e;
  }
}

export async function updateSectionTeacher(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateSectionTeacherInput,
): Promise<unknown> {
  await loadAssignment(tenant.id, id);
  await assertTeacher(tenant.id, input.teacherId);
  const [row] = await db
    .update(sectionTeachers)
    .set({ teacherId: input.teacherId })
    .where(and(eq(sectionTeachers.id, id), eq(sectionTeachers.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

export async function removeSectionTeacher(tenant: TenantContext, id: bigint): Promise<void> {
  await loadAssignment(tenant.id, id);
  await db.delete(sectionTeachers).where(and(eq(sectionTeachers.id, id), eq(sectionTeachers.tenantId, tenant.id)));
}

// ================================================================ TIMETABLE ENTRIES
interface EntryShape {
  sectionId: bigint;
  subjectId: bigint;
  teacherId: bigint;
  timeSlotId: bigint;
  classroomId: bigint | null;
  dayOfWeek: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
}

// Is the section, the teacher or the classroom already busy in this slot, on this day, at an overlapping time?
async function assertNoClash(tenantId: bigint, e: EntryShape, selfId?: bigint) {
  const clashes = await db
    .select({
      sectionId: timetableEntries.sectionId,
      teacherId: timetableEntries.teacherId,
      classroomId: timetableEntries.classroomId,
      classroomIds: timetableEntries.classroomIds,
    })
    .from(timetableEntries)
    .where(
      and(
        eq(timetableEntries.tenantId, tenantId),
        eq(timetableEntries.status, 'active'),
        eq(timetableEntries.timeSlotId, e.timeSlotId),
        eq(timetableEntries.dayOfWeek, e.dayOfWeek),
        selfId === undefined ? undefined : ne(timetableEntries.id, selfId),
        // date ranges overlap: the other entry starts before we end (if we end) and has not ended before we start
        e.effectiveTo ? lte(timetableEntries.effectiveFrom, e.effectiveTo) : undefined,
        or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, e.effectiveFrom)),
        or(
          eq(timetableEntries.sectionId, e.sectionId),
          eq(timetableEntries.teacherId, e.teacherId),
          // a planner lesson can use several rooms: classroomId is only the first, classroomIds holds all of them
          e.classroomId
            ? or(
                eq(timetableEntries.classroomId, e.classroomId),
                sql`${e.classroomId} = ANY(${timetableEntries.classroomIds})`,
              )
            : undefined,
        ),
      ),
    );

  if (clashes.some((c) => c.sectionId === e.sectionId)) {
    throw new HttpError(409, 'This section already has a lesson in that period');
  }
  if (clashes.some((c) => c.teacherId === e.teacherId)) {
    throw new HttpError(409, 'This teacher is already teaching another class in that period');
  }
  const room = e.classroomId;
  if (room && clashes.some((c) => c.classroomId === room || c.classroomIds.includes(room))) {
    throw new HttpError(409, 'This classroom is already in use in that period');
  }
}

// Every rule an ACTIVE entry must satisfy. Used by both create and update.
async function validateEntry(tenantId: bigint, e: EntryShape, selfId?: bigint): Promise<void> {
  if (e.effectiveTo && e.effectiveTo < e.effectiveFrom) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'effectiveTo', message: 'Cannot be before effectiveFrom' },
    ]);
  }

  const section = await loadSection(tenantId, e.sectionId);

  const [slot] = await db
    .select()
    .from(timeSlots)
    .where(and(eq(timeSlots.id, e.timeSlotId), eq(timeSlots.tenantId, tenantId)))
    .limit(1);
  if (!slot) throw new HttpError(400, 'Time slot not found in this school');
  if (slot.isBreak) throw new HttpError(400, 'A lesson cannot be scheduled in a break');
  if (!slot.isActive) throw new HttpError(400, 'That time slot is not active');
  // an active lesson only makes sense on a weekday the slot actually runs (a Friday bell has no Monday period)
  if (e.status === 'active' && !slot.days.includes(e.dayOfWeek)) {
    throw new HttpError(400, 'That time slot does not run on this day');
  }

  await assertSubjectTaughtInClass(tenantId, section.classId, e.subjectId);
  await assertTeacher(tenantId, e.teacherId);
  if (e.classroomId) await assertClassroom(tenantId, e.classroomId);

  if (e.status === 'active') await assertNoClash(tenantId, e, selfId);
}

export async function listEntries(tenant: TenantContext, q: ListEntriesInput) {
  const today = q.onDate === 'today' ? await schoolToday(tenant) : undefined;
  const onDate = today ?? q.onDate;
  const where = and(
    eq(timetableEntries.tenantId, tenant.id),
    q.sectionId ? eq(timetableEntries.sectionId, q.sectionId) : undefined,
    q.teacherId ? eq(timetableEntries.teacherId, q.teacherId) : undefined,
    q.classroomId ? eq(timetableEntries.classroomId, q.classroomId) : undefined,
    q.timeSlotId ? eq(timetableEntries.timeSlotId, q.timeSlotId) : undefined,
    q.academicYearId ? eq(timetableEntries.academicYearId, q.academicYearId) : undefined,
    q.dayOfWeek ? eq(timetableEntries.dayOfWeek, q.dayOfWeek) : undefined,
    q.status ? eq(timetableEntries.status, q.status) : undefined,
    onDate
      ? and(
          lte(timetableEntries.effectiveFrom, onDate),
          or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, onDate)),
        )
      : undefined,
  );
  const visibleSlot = onDate
    ? and(eq(timeSlots.isActive, true), sql`${timetableEntries.dayOfWeek} = ANY(${timeSlots.days})`)
    : undefined;
  const sectionId = q.sectionId;
  const isPlannerManaged = today && sectionId && q.academicYearId
    ? db
        .select({ id: timetableEntries.id })
        .from(timetableEntries)
        .where(and(
          eq(timetableEntries.tenantId, tenant.id),
          eq(timetableEntries.sectionId, sectionId),
          eq(timetableEntries.academicYearId, q.academicYearId),
          eq(timetableEntries.status, 'active'),
          eq(timetableEntries.source, 'planner'),
          or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, today)),
        ))
        .limit(1)
        .then((entries) => entries.length > 0)
    : undefined;

  const [rows, [{ total }], plannerManaged] = await Promise.all([
    db
      .select({
        id: timetableEntries.id,
        sectionId: timetableEntries.sectionId,
        sectionName: sections.name,
        className: classes.name,
        subjectId: timetableEntries.subjectId,
        subjectCode: subjects.code,
        // planner rows may have no subject: show their title in its place
        subjectName: sql<string | null>`coalesce(${subjects.name}, ${timetableEntries.title})`,
        title: timetableEntries.title,
        source: timetableEntries.source,
        subjectColor: subjects.color,
        teacherId: timetableEntries.teacherId,
        teacherName: staff.fullName,
        timeSlotId: timetableEntries.timeSlotId,
        slotName: timeSlots.name,
        slotSequence: timeSlots.sequence,
        startsAt: timeSlots.startsAt,
        endsAt: timeSlots.endsAt,
        classroomId: timetableEntries.classroomId,
        classroomCode: classrooms.code,
        classroomIds: timetableEntries.classroomIds,
        classroomCodes: sql<string[]>`ARRAY(
          SELECT ${classrooms.code} FROM ${classrooms}
          WHERE ${classrooms.tenantId} = ${timetableEntries.tenantId}
            AND ${classrooms.id} = ANY(${timetableEntries.classroomIds})
          ORDER BY ${classrooms.code}
        )`,
        dayOfWeek: timetableEntries.dayOfWeek,
        academicYearId: timetableEntries.academicYearId,
        effectiveFrom: timetableEntries.effectiveFrom,
        effectiveTo: timetableEntries.effectiveTo,
        status: timetableEntries.status,
      })
      .from(timetableEntries)
      .innerJoin(sections, eq(timetableEntries.sectionId, sections.id))
      .innerJoin(classes, eq(sections.classId, classes.id))
      .leftJoin(subjects, eq(timetableEntries.subjectId, subjects.id))
      .leftJoin(staff, eq(timetableEntries.teacherId, staff.id))
      .innerJoin(timeSlots, eq(timetableEntries.timeSlotId, timeSlots.id))
      .leftJoin(classrooms, eq(timetableEntries.classroomId, classrooms.id))
      .where(and(where, visibleSlot))
      .orderBy(asc(timetableEntries.dayOfWeek), asc(timeSlots.sequence), asc(timetableEntries.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(timetableEntries)
      .innerJoin(timeSlots, eq(timetableEntries.timeSlotId, timeSlots.id))
      .where(and(where, visibleSlot)),
    isPlannerManaged,
  ]);

  return { rows, meta: { ...pageMeta(q.page, q.limit, total), today, plannerManaged } };
}

async function loadEntry(tenantId: bigint, id: bigint) {
  const [row] = await db
    .select()
    .from(timetableEntries)
    .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Timetable entry not found');
  return row;
}

// Rows the timetable planner wrote are changed only by the planner (a new version), never through /api/timetable.
function assertNotPlannerRow(row: { source: string }) {
  if (row.source === 'planner') {
    throw new HttpError(409, 'This lesson is managed by the timetable planner. Change it there.');
  }
}

export async function createEntry(tenant: TenantContext, _actor: AuthUser, input: CreateEntryInput): Promise<unknown> {
  const academicYearId = await resolveAcademicYearId(tenant, input.academicYearId);
  // no teacher sent: use the one assigned to this subject for the section (section_teachers)
  let teacherId = input.teacherId;
  if (teacherId === undefined) {
    const [assigned] = await db
      .select({ teacherId: sectionTeachers.teacherId })
      .from(sectionTeachers)
      .where(
        and(
          eq(sectionTeachers.tenantId, tenant.id),
          eq(sectionTeachers.sectionId, input.sectionId),
          eq(sectionTeachers.subjectId, input.subjectId),
          eq(sectionTeachers.academicYearId, academicYearId),
        ),
      )
      .limit(1);
    if (!assigned) {
      throw new HttpError(400, 'No teacher is assigned to this subject for the section: send teacherId or assign one first');
    }
    teacherId = assigned.teacherId;
  }

  const shape: EntryShape = {
    sectionId: input.sectionId,
    subjectId: input.subjectId,
    teacherId,
    timeSlotId: input.timeSlotId,
    classroomId: input.classroomId ?? null,
    dayOfWeek: input.dayOfWeek,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    status: 'active',
  };
  await validateEntry(tenant.id, shape);

  const [row] = await db
    .insert(timetableEntries)
    .values({ ...shape, tenantId: tenant.id, academicYearId, source: 'manual' })
    .returning();
  return toRow(row);
}

export async function updateEntry(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateEntryInput,
): Promise<unknown> {
  const existing = await loadEntry(tenant.id, id);
  assertNotPlannerRow(existing);

  // manual rows are only ever written with a subject and a teacher (planner rows, which may lack them, were refused above)
  const subjectId = (input.subjectId ?? existing.subjectId) as bigint;
  const teacherId = (input.teacherId ?? existing.teacherId) as bigint;

  const next: EntryShape = {
    sectionId: existing.sectionId,
    subjectId,
    teacherId,
    timeSlotId: input.timeSlotId ?? existing.timeSlotId,
    classroomId: input.classroomId !== undefined ? input.classroomId : existing.classroomId,
    dayOfWeek: input.dayOfWeek ?? existing.dayOfWeek,
    effectiveFrom: input.effectiveFrom ?? existing.effectiveFrom,
    effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : existing.effectiveTo,
    status: input.status ?? existing.status,
  };

  if (next.status === 'active') {
    await validateEntry(tenant.id, next, id);
  } else if (next.effectiveTo && next.effectiveTo < next.effectiveFrom) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'effectiveTo', message: 'Cannot be before effectiveFrom' },
    ]);
  }

  const [row] = await db
    .update(timetableEntries)
    .set(next) // never touches source, versionId or archivedByVersionId
    .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// "Delete" switches the entry off and keeps it, so the timetable history is not lost.
export async function removeEntry(tenant: TenantContext, id: bigint): Promise<void> {
  assertNotPlannerRow(await loadEntry(tenant.id, id));
  await db
    .update(timetableEntries)
    .set({ status: 'inactive' })
    .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenant.id)));
}