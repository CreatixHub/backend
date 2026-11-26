import { createHash } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  academicYears, classes, classrooms, organizations, periodAttendance, sections, staff, timeSlots, timetableEntries, timetableVersions,
  type PreviousPlannerSlot,
} from '../../db/schema';
import { todayInTimezone } from '../../lib/dates';
import { HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { isDeadlock, isForeignKeyViolation, isUniqueViolation, pgConstraint } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import { Schedule } from './engine/engine';
import { loadPlannerSnapshot, readPlannerSnapshot } from './planner.problem';
import {
  bellSlotDefs, countClassPeriods, describeConflicts, findConflicts, findProtectedSlotIssues, projectEntries, slotKey,
  teachingPeriodsByDay,
  type Booking, type ConflictNames, type ProjectedRow, type SlotDef, type SlotRecord, type SlotTarget, type SlotTime,
} from './planner.publishCore';
import { lockPlannerSettings, type PlannerExecutor, type PlannerTransaction } from './planner.settings';
import { findPlannerVersion, fingerprintOf, type PlannerVersion } from './planner.versions';

type Snapshot = Awaited<ReturnType<typeof loadPlannerSnapshot>>;
type SlotRow = typeof timeSlots.$inferSelect;

const INSERT_CHUNK = 1000;

// ------------------------------------------------------------------ helpers

async function versionYear(tenant: TenantContext, versionId: bigint) {
  const [row] = await db.select({ yearId: timetableVersions.academicYearId }).from(timetableVersions)
    .where(and(eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.id, versionId)));
  if (!row) throw new HttpError(404, 'Timetable was not found.');
  return row.yearId;
}

async function currentPublication(executor: PlannerExecutor, tenant: TenantContext, yearId: bigint) {
  const [published] = await executor.select({ id: timetableVersions.id }).from(timetableVersions).where(and(
    eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.academicYearId, yearId),
    eq(timetableVersions.status, 'published'),
  ));
  return published?.id ?? null;
}

async function schoolToday(executor: PlannerExecutor, tenant: TenantContext) {
  const [org] = await executor.select({ timezone: organizations.timezone }).from(organizations)
    .where(eq(organizations.id, tenant.id));
  return todayInTimezone(org?.timezone ?? 'UTC');
}

/** The sections a publication replaces: every section that has a lesson on the version. */
const scopeSectionIds = (version: PlannerVersion) =>
  [...new Set(version.entries.map((entry) => entry.sectionId))].map((id) => BigInt(id));

const loadSlots = (executor: PlannerExecutor, tenant: TenantContext) =>
  executor.select().from(timeSlots).where(eq(timeSlots.tenantId, tenant.id));

const sectionRows = (tenant: TenantContext, yearId: bigint, sectionIds: bigint[]) =>
  and(
    eq(timetableEntries.tenantId, tenant.id), eq(timetableEntries.academicYearId, yearId),
    inArray(timetableEntries.sectionId, sectionIds),
  );

const unique = <T>(values: T[]): T[] => [...new Set(values)];

type BookingRow = {
  sectionId: bigint; teacherId: bigint | null; classroomId: bigint | null; classroomIds: bigint[]; timeSlotId: bigint; day: number;
};
const bookingColumns = {
  sectionId: timetableEntries.sectionId,
  teacherId: timetableEntries.teacherId,
  classroomId: timetableEntries.classroomId,
  classroomIds: timetableEntries.classroomIds,
  timeSlotId: timetableEntries.timeSlotId,
  day: timetableEntries.dayOfWeek,
};

// Every room of an entry counts, not only `classroom_id`: a planner lesson can hold several rooms.
const toBooking = (row: BookingRow): Booking => ({
  sectionId: row.sectionId.toString(),
  day: row.day,
  slotId: row.timeSlotId.toString(),
  teacherId: row.teacherId === null ? null : row.teacherId.toString(),
  roomIds: unique([...(row.classroomId === null ? [] : [row.classroomId]), ...row.classroomIds].map(String)),
});

/** Active entries of this school and year that a publication does not replace. */
async function keptBookings(
  executor: PlannerExecutor, tenant: TenantContext, yearId: bigint,
  { notInSections, notEndedBefore, notIds }: { notInSections?: bigint[]; notEndedBefore?: string; notIds?: bigint[] } = {},
) {
  const rows = await executor.select(bookingColumns).from(timetableEntries).where(and(
    eq(timetableEntries.tenantId, tenant.id), eq(timetableEntries.academicYearId, yearId), eq(timetableEntries.status, 'active'),
    notInSections?.length ? notInArray(timetableEntries.sectionId, notInSections) : undefined,
    notIds?.length ? notInArray(timetableEntries.id, notIds) : undefined,
    // a lesson that ended before the new timetable starts cannot clash with it
    notEndedBefore ? or(isNull(timetableEntries.effectiveTo), gte(timetableEntries.effectiveTo, notEndedBefore)) : undefined,
  ));
  return rows.map(toBooking);
}

const toSlotRecord = (row: SlotRow): SlotRecord => ({
  id: row.id.toString(), dayType: row.dayType, sequence: row.sequence, name: row.name, startsAt: row.startsAt,
  endsAt: row.endsAt, isBreak: row.isBreak, days: [...row.days],
});

/**
 * The classes that still have an active lesson in each period without being part of this publication: other classes of the
 * year, and every class of any other academic year (periods are shared by the whole school).
 */
async function slotsUsedOutside(executor: PlannerExecutor, tenant: TenantContext, yearId: bigint, sectionIds: bigint[]) {
  const rows = await executor.select({
    slotId: timetableEntries.timeSlotId, section: sections.name, className: classes.name, year: academicYears.name,
    yearId: timetableEntries.academicYearId,
  }).from(timetableEntries)
    .innerJoin(sections, eq(sections.id, timetableEntries.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .innerJoin(academicYears, eq(academicYears.id, timetableEntries.academicYearId))
    .where(and(
      eq(timetableEntries.tenantId, tenant.id), eq(timetableEntries.status, 'active'),
      sectionIds.length ? or(ne(timetableEntries.academicYearId, yearId), notInArray(timetableEntries.sectionId, sectionIds)) : undefined,
    ));
  const used = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.slotId.toString();
    const label = `${row.className} ${row.section}${row.yearId === yearId ? '' : ` (${row.year})`}`;
    used.set(key, [...(used.get(key) ?? []), label]);
  }
  return used;
}

async function conflictNames(
  executor: PlannerExecutor, tenant: TenantContext, conflicts: ReturnType<typeof findConflicts>,
): Promise<ConflictNames> {
  const ids = (pick: (conflict: (typeof conflicts)[number]) => string[]) => unique(conflicts.flatMap(pick)).map((id) => BigInt(id));
  const teacherIds = ids((c) => (c.kind === 'teacher' ? [c.resourceId] : []));
  const roomIds = ids((c) => (c.kind === 'room' ? [c.resourceId] : []));
  const sectionIds = ids((c) => [c.sectionId, c.otherSectionId]);

  const teachers = new Map<string, string>();
  if (teacherIds.length) {
    const rows = await executor.select({ id: staff.id, fullName: staff.fullName, firstName: staff.firstName, lastName: staff.lastName })
      .from(staff).where(and(eq(staff.tenantId, tenant.id), inArray(staff.id, teacherIds)));
    for (const row of rows) {
      teachers.set(row.id.toString(), row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || `Teacher ${row.id}`);
    }
  }
  const rooms = new Map<string, string>();
  if (roomIds.length) {
    const rows = await executor.select({ id: classrooms.id, name: classrooms.name, code: classrooms.code })
      .from(classrooms).where(and(eq(classrooms.tenantId, tenant.id), inArray(classrooms.id, roomIds)));
    for (const row of rows) rooms.set(row.id.toString(), row.name || row.code);
  }
  const sectionNames = new Map<string, string>();
  if (sectionIds.length) {
    const rows = await executor.select({ id: sections.id, name: sections.name, className: classes.name })
      .from(sections).innerJoin(classes, eq(classes.id, sections.classId))
      .where(and(eq(sections.tenantId, tenant.id), inArray(sections.id, sectionIds)));
    for (const row of rows) sectionNames.set(row.id.toString(), `${row.className} ${row.name}`);
  }
  return {
    teacher: (id) => teachers.get(id) ?? 'A teacher',
    room: (id) => rooms.get(id) ?? 'A room',
    section: (id) => sectionNames.get(id) ?? 'another class',
  };
}

async function describeAll(executor: PlannerExecutor, tenant: TenantContext, conflicts: ReturnType<typeof findConflicts>) {
  return conflicts.length ? describeConflicts(conflicts, await conflictNames(executor, tenant, conflicts)) : [];
}

function conflictError(prefix: string, messages: string[]) {
  return new HttpError(409, `${prefix} ${messages.join(' ')}`, messages.map((message) => ({ field: 'conflicts', message })));
}

// ------------------------------------------------------------------ what blocks a publication

/** Everything that stops a draft being published, in words the planner can show. */
function assess(version: PlannerVersion, snapshot: Snapshot) {
  const blockers: string[] = [];
  if (version.status === 'published') blockers.push('This timetable is already published.');
  else if (version.status !== 'draft') blockers.push('Make a draft copy before publishing.');
  if (version.status !== 'draft') return { blockers, unplaced: 0 };

  const { problem } = snapshot;
  if (version.fingerprint !== fingerprintOf(problem)) {
    blockers.push('The plan or the bell changed after this timetable was generated. Generate it again before publishing.');
  }

  // Names come from the plan the draft was generated from, ids are checked against today's school.
  const teachers = new Set(problem.staff.map((teacher) => teacher.id));
  const subjectIds = new Set(snapshot.lookups.subjects.map((subject) => subject.id));
  const rooms = new Set(problem.rooms.map((room) => room.id));
  const classesNow = new Set(problem.sections.map((section) => section.id));
  const teacherName = new Map(version.problem.staff.map((teacher) => [teacher.id, teacher.name]));
  const roomName = new Map(version.problem.rooms.map((room) => [room.id, room.name]));
  const sectionName = new Map(version.problem.sections.map((section) => [section.id, `${section.className ?? ''} ${section.name}`.trim()]));
  const missing = { teacher: new Set<string>(), subject: new Set<string>(), room: new Set<string>(), section: new Set<string>() };
  for (const entry of version.entries) {
    if (!classesNow.has(entry.sectionId)) missing.section.add(sectionName.get(entry.sectionId) ?? `Class ${entry.sectionId}`);
    if (entry.subjectId && !subjectIds.has(entry.subjectId)) missing.subject.add(entry.subjectName);
    for (const id of entry.teacherIds) if (!teachers.has(id)) missing.teacher.add(teacherName.get(id) ?? `Teacher ${id}`);
    for (const id of entry.roomIds) if (!rooms.has(id)) missing.room.add(roomName.get(id) ?? `Room ${id}`);
  }
  for (const name of missing.teacher) blockers.push(`Teacher "${name}" is no longer an active teacher. Change the teaching plan and generate again.`);
  for (const name of missing.subject) blockers.push(`Subject "${name}" no longer exists. Change the teaching plan and generate again.`);
  for (const name of missing.room) blockers.push(`Room "${name}" is no longer available. Change the teaching plan and generate again.`);
  for (const name of missing.section) blockers.push(`Class "${name}" is no longer part of the plan. Generate again.`);

  let unplaced = 0;
  try {
    const schedule = Schedule.fromEntries(problem, version.entries, { seed: version.seed });
    unplaced = schedule.unplaced().length;
    if (schedule.dropped.length) blockers.push('Some saved placements no longer match the plan. Generate it again before publishing.');
    for (const violation of schedule.criticalViolations().values()) {
      blockers.push(schedule.describeCritical(violation));
    }
  } catch {
    blockers.push('This timetable no longer matches the plan. Generate it again before publishing.');
  }
  if (unplaced) {
    blockers.push(`${unplaced} lesson${unplaced === 1 ? ' is' : 's are'} not placed on the timetable yet. Place ${unplaced === 1 ? 'it' : 'them'} before publishing.`);
  } else if (!version.entries.length) {
    blockers.push('This timetable has no lessons on it.');
  }
  return { blockers, unplaced };
}

/** The bell and lessons of a version as rows, against the slots that exist now (new periods get a placeholder id). */
function project(version: PlannerVersion, slots: SlotRow[]) {
  const defs = bellSlotDefs(version.bell);
  const ids = new Map(slots.map((slot) => [slotKey(slot.dayType, slot.sequence), slot.id.toString()]));
  const slotIdFor = (key: string) => ids.get(key) ?? `new:${key}`;
  const rows = projectEntries(version.entries, teachingPeriodsByDay(version.bell, slotIdFor));
  const slotTimes = new Map<string, SlotTime>(slots.map((slot) => [slot.id.toString(), { startsAt: slot.startsAt, endsAt: slot.endsAt }]));
  for (const def of defs) slotTimes.set(slotIdFor(slotKey(def.dayType, def.sequence)), { startsAt: def.startsAt, endsAt: def.endsAt });
  return { defs, rows, slotTimes };
}

// ------------------------------------------------------------------ preview

async function publicationScope(executor: PlannerExecutor, tenant: TenantContext, yearId: bigint, sectionIds: bigint[]) {
  if (!sectionIds.length) return [];
  return executor.select({ id: timetableEntries.id, source: timetableEntries.source, updatedAt: timetableEntries.updatedAt })
    .from(timetableEntries)
    .where(and(sectionRows(tenant, yearId, sectionIds), eq(timetableEntries.status, 'active')))
    .orderBy(asc(timetableEntries.id));
}

function previewRevision(version: PlannerVersion, effectiveFrom: string, scope: Awaited<ReturnType<typeof publicationScope>>) {
  const replaced = scope.map((row) => [row.id.toString(), row.source, row.updatedAt]);
  const checked = [version.id.toString(), version.editRevision, version.fingerprint, effectiveFrom, replaced];
  return createHash('sha256').update(JSON.stringify(checked)).digest('hex');
}

export async function previewPublish(tenant: TenantContext, versionId: bigint, academicYearId?: bigint) {
  const yearId = academicYearId ?? await versionYear(tenant, versionId);
  const version = await findPlannerVersion(db, tenant, yearId, versionId);
  const snapshot = await readPlannerSnapshot(tenant, yearId);
  const { blockers, unplaced } = assess(version, snapshot);
  const effectiveFrom = await schoolToday(db, tenant);
  const sectionIds = scopeSectionIds(version);

  let projection: ReturnType<typeof project> | undefined;
  const slots = await loadSlots(db, tenant);
  try {
    projection = project(version, slots);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    blockers.push(error.message);
  }
  const rows: ProjectedRow[] = projection?.rows ?? [];

  if (projection && version.status === 'draft') {
    blockers.push(...findProtectedSlotIssues(
      slots.map(toSlotRecord), projection.defs, await slotsUsedOutside(db, tenant, yearId, sectionIds),
    ));
  }
  if (projection && version.status === 'draft' && rows.length) {
    const kept = await keptBookings(db, tenant, yearId, { notInSections: sectionIds, notEndedBefore: effectiveFrom });
    blockers.push(...await describeAll(db, tenant, findConflicts(rows, kept, projection.slotTimes)));
  }

  const inScope = await publicationScope(db, tenant, yearId, sectionIds);
  const activeIn = (source: string) => inScope.filter((row) => row.source === source).length;

  return {
    revision: previewRevision(version, effectiveFrom, inScope),
    academicYearId: yearId.toString(),
    sectionIds: sectionIds.map(String),
    classEntries: countClassPeriods(rows),
    classes: sectionIds.length,
    teacherEntries: rows.filter((row) => row.teacherId !== null).length,
    teachers: new Set(rows.flatMap((row) => (row.teacherId === null ? [] : [row.teacherId]))).size,
    periodRows: projection?.defs.length ?? 0,
    plannerEntriesReplaced: activeIn('planner'),
    manualEntriesArchived: activeIn('manual'),
    blockers,
    unplaced,
  };
}

// ------------------------------------------------------------------ slots

const sameSlot = (row: SlotRow, def: SlotDef) =>
  row.isActive && row.name === def.name && row.startsAt === def.startsAt && row.endsAt === def.endsAt
  && row.isBreak === def.isBreak && row.durationMinutes === def.durationMinutes
  && [...row.days].sort().join() === [...def.days].sort().join();

const toPrevious = (row: SlotRow): PreviousPlannerSlot => ({
  id: row.id.toString(), dayType: row.dayType, days: [...row.days], sequence: row.sequence, name: row.name,
  startsAt: row.startsAt, endsAt: row.endsAt, isBreak: row.isBreak, durationMinutes: row.durationMinutes, isActive: row.isActive,
});

/** Create or update the periods of the bell (matched by day type and sequence) and return what they were before. */
async function upsertSlots(tx: PlannerTransaction, tenant: TenantContext, defs: SlotDef[], existing: SlotRow[]) {
  const byKey = new Map(existing.map((slot) => [slotKey(slot.dayType, slot.sequence), slot]));
  const previous: PreviousPlannerSlot[] = [];
  const inserts: SlotDef[] = [];
  for (const def of defs) {
    const row = byKey.get(slotKey(def.dayType, def.sequence));
    if (!row) {
      inserts.push(def);
    } else if (!sameSlot(row, def)) {
      previous.push(toPrevious(row));
      await tx.update(timeSlots).set({
        name: def.name, days: def.days, startsAt: def.startsAt, endsAt: def.endsAt, isBreak: def.isBreak,
        durationMinutes: def.durationMinutes, isActive: true,
      }).where(and(eq(timeSlots.id, row.id), eq(timeSlots.tenantId, tenant.id)));
    }
  }
  if (inserts.length) {
    const created = await tx.insert(timeSlots).values(inserts.map((def) => ({ tenantId: tenant.id, ...def }))).returning();
    previous.push(...created.map((row) => ({ ...toPrevious(row), created: true })));
  }
  return previous;
}

/** How each slot is used: by active lessons, by any lesson or attendance record. */
async function slotUsage(tx: PlannerTransaction, tenant: TenantContext, slotIds: bigint[]) {
  const usage = new Map<string, { active: number; used: boolean }>();
  if (!slotIds.length) return usage;
  const entries = await tx.select({
    slotId: timetableEntries.timeSlotId,
    active: sql<number>`count(*) filter (where ${timetableEntries.status} = 'active')`.mapWith(Number),
  }).from(timetableEntries)
    .where(and(eq(timetableEntries.tenantId, tenant.id), inArray(timetableEntries.timeSlotId, slotIds)))
    .groupBy(timetableEntries.timeSlotId);
  const attendance = await tx.selectDistinct({ slotId: periodAttendance.timeSlotId }).from(periodAttendance)
    .where(and(eq(periodAttendance.tenantId, tenant.id), inArray(periodAttendance.timeSlotId, slotIds)));
  for (const row of entries) usage.set(row.slotId.toString(), { active: row.active, used: true });
  for (const row of attendance) {
    const id = row.slotId.toString();
    usage.set(id, { active: usage.get(id)?.active ?? 0, used: true });
  }
  return usage;
}

/**
 * A slot the new bell no longer has: delete it when nothing refers to it, switch it off when only old (inactive)
 * lessons or attendance records do, and leave it alone while a lesson of another class still runs in it.
 */
async function retireSlots(tx: PlannerTransaction, tenant: TenantContext, retiring: SlotRow[]) {
  const previous: PreviousPlannerSlot[] = [];
  const usage = await slotUsage(tx, tenant, retiring.map((slot) => slot.id));
  for (const slot of retiring) {
    const used = usage.get(slot.id.toString());
    if (used && used.active > 0) continue;
    if (used) {
      if (!slot.isActive) continue;
      await tx.update(timeSlots).set({ isActive: false }).where(and(eq(timeSlots.id, slot.id), eq(timeSlots.tenantId, tenant.id)));
    } else {
      await tx.delete(timeSlots).where(and(eq(timeSlots.id, slot.id), eq(timeSlots.tenantId, tenant.id)));
    }
    previous.push(toPrevious(slot));
  }
  return previous;
}

/** Put the periods back the way a publication found them. */
async function restoreSlots(tx: PlannerTransaction, tenant: TenantContext, previous: PreviousPlannerSlot[]) {
  const existing = await loadSlots(tx, tenant);
  const byId = new Map(existing.map((slot) => [slot.id.toString(), slot]));
  const createdRows = previous.flatMap((slot) => (slot.created && byId.has(slot.id) ? [byId.get(slot.id)!] : []));
  await retireSlots(tx, tenant, createdRows);
  for (const slot of previous) {
    if (slot.created) continue;
    const values = {
      dayType: slot.dayType, days: slot.days, sequence: slot.sequence, name: slot.name, startsAt: slot.startsAt,
      endsAt: slot.endsAt, isBreak: slot.isBreak, durationMinutes: slot.durationMinutes, isActive: slot.isActive,
    };
    if (byId.has(slot.id)) {
      await tx.update(timeSlots).set(values).where(and(eq(timeSlots.id, BigInt(slot.id)), eq(timeSlots.tenantId, tenant.id)));
    } else {
      await tx.insert(timeSlots).values({ id: BigInt(slot.id), tenantId: tenant.id, ...values });
    }
  }
}

// ------------------------------------------------------------------ publish

// Only the fields that say what went wrong: never the whole error, which can carry the query and its parameters.
function pgErrorSummary(error: unknown) {
  const source = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown> & { cause?: Record<string, unknown> };
  const pick = (field: string) => source[field] ?? source.cause?.[field];
  return { code: pick('code'), constraint: pick('constraint'), table: pick('table'), detail: pick('detail') };
}

// A concurrent change shows up as a deadlock, a vanished row, or a second published version of the year: tell the user to retry.
function mapDatabaseConflict(error: unknown, verb: string): never {
  const raced = isDeadlock(error) || isForeignKeyViolation(error)
    || (isUniqueViolation(error) && ['timetable_versions_published_year_key', 'time_slots_tenant_id_day_type_sequence_key'].includes(pgConstraint(error) ?? ''));
  if (raced) {
    logger.warn({ pg: pgErrorSummary(error), verb }, 'Planner publish or restore hit a database conflict and asked the user to retry');
    throw new HttpError(409, `The timetable changed while ${verb}. Please try again.`);
  }
  throw error;
}

export async function publishVersion(
  tenant: TenantContext, actor: { id: bigint }, versionId: bigint, input: { effectiveFrom?: string; revision?: string } = {},
  academicYearId?: bigint,
): Promise<{ entries: number }> {
  const yearId = academicYearId ?? await versionYear(tenant, versionId);
  const previousId = await currentPublication(db, tenant, yearId);
  try {
    return await db.transaction(async (tx) => {
      // Same lock order as every planner write: school, settings row, then the version. Time slots are shared by every
      // academic year of the school, so publishing takes the school-wide lock and runs one at a time per school.
      // Year rollover (ending the old year's planner rows with an effective-to date when a new year publishes) is not
      // handled here: another year's active rows are only protected from slot changes, never edited.
      await lockPlannerSettings(tx, tenant, yearId, true);
      const version = await findPlannerVersion(tx, tenant, yearId, versionId, { forUpdate: true });
      if (await currentPublication(tx, tenant, yearId) !== previousId) {
        throw new HttpError(409, 'Another timetable was published while this request was waiting. Refresh the publishing preview and review it again.');
      }
      const { blockers } = assess(version, await loadPlannerSnapshot(tx, tenant, yearId));
      if (blockers.length) {
        throw new HttpError(409, blockers.join(' '), blockers.map((message) => ({ field: 'blockers', message })));
      }

      const effectiveFrom = input.effectiveFrom ?? await schoolToday(tx, tenant);
      const sectionIds = scopeSectionIds(version);
      if (input.revision !== undefined) {
        const replaced = await publicationScope(tx, tenant, yearId, sectionIds);
        if (input.revision !== previewRevision(version, effectiveFrom, replaced)) {
          throw new HttpError(409, 'The timetable or the lessons it would replace changed. Refresh the publishing preview and review it again.');
        }
      }
      const defs = bellSlotDefs(version.bell);
      const before = await loadSlots(tx, tenant); // read only after the lock, so previousSlots is what restore must bring back
      const moved = findProtectedSlotIssues(before.map(toSlotRecord), defs, await slotsUsedOutside(tx, tenant, yearId, sectionIds));
      if (moved.length) throw conflictError('This timetable cannot be published because other classes still use periods it would change:', moved);
      const previousSlots = await upsertSlots(tx, tenant, defs, before);

      // Conflicts are checked against the periods as they will be once this bell is in place.
      const { rows, slotTimes } = project(version, await loadSlots(tx, tenant));
      const kept = await keptBookings(tx, tenant, yearId, { notInSections: sectionIds, notEndedBefore: effectiveFrom });
      const conflicts = await describeAll(tx, tenant, findConflicts(rows, kept, slotTimes));
      if (conflicts.length) throw conflictError('This timetable cannot be published because it double-books:', conflicts);

      // Planner rows being replaced and manual rows of the same classes stop counting; restore flips exactly these back.
      await tx.update(timetableEntries).set({ status: 'inactive', archivedByVersionId: version.id })
        .where(and(sectionRows(tenant, yearId, sectionIds), eq(timetableEntries.status, 'active')));

      const keep = new Set(defs.map((def) => slotKey(def.dayType, def.sequence)));
      previousSlots.push(...await retireSlots(tx, tenant, before.filter((slot) => !keep.has(slotKey(slot.dayType, slot.sequence)))));

      const values = rows.map((row) => {
        const roomIds = row.roomIds.map((id) => BigInt(id));
        return {
          tenantId: tenant.id, academicYearId: yearId, sectionId: BigInt(row.sectionId),
          subjectId: row.subjectId === null ? null : BigInt(row.subjectId),
          teacherId: row.teacherId === null ? null : BigInt(row.teacherId),
          title: row.title, source: 'planner', versionId: version.id, timeSlotId: BigInt(row.slotId), dayOfWeek: row.day,
          classroomId: roomIds[0] ?? null, classroomIds: roomIds, effectiveFrom, status: 'active',
        };
      });
      for (let start = 0; start < values.length; start += INSERT_CHUNK) {
        await tx.insert(timetableEntries).values(values.slice(start, start + INSERT_CHUNK));
      }

      if (previousId !== null) {
        await tx.update(timetableVersions).set({ status: 'archived' }).where(and(
          eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.id, previousId),
        ));
      }
      await tx.update(timetableVersions).set({
        status: 'published', publishedBy: actor.id, publishedAt: new Date(), previousVersionId: previousId, previousSlots,
      }).where(and(eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.id, version.id)));
      return { entries: values.length };
    });
  } catch (error) {
    return mapDatabaseConflict(error, 'publishing');
  }
}

// ------------------------------------------------------------------ restore

export async function restoreVersion(
  tenant: TenantContext, _actor: { id: bigint }, versionId: bigint, academicYearId?: bigint,
): Promise<void> {
  const yearId = academicYearId ?? await versionYear(tenant, versionId);
  try {
    await db.transaction(async (tx) => {
      await lockPlannerSettings(tx, tenant, yearId, true); // periods are shared by every year: one publish or restore at a time per school
      const version = await findPlannerVersion(tx, tenant, yearId, versionId, { forUpdate: true });
      if (version.status !== 'published' || version.previousSlots === null) {
        throw new HttpError(409, 'Only the published timetable can be restored to the one before it.');
      }
      const [previous] = version.previousVersionId === null ? [] : await tx.select().from(timetableVersions).where(and(
        eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.academicYearId, yearId),
        eq(timetableVersions.id, version.previousVersionId),
      )).for('update');

      // Putting the old period definitions back must not move periods other classes (or other years) still use.
      const target: SlotTarget[] = version.previousSlots.filter((slot) => !slot.created).map((slot) => ({
        dayType: slot.dayType, sequence: slot.sequence, name: slot.name, startsAt: slot.startsAt, endsAt: slot.endsAt,
        isBreak: slot.isBreak, days: slot.days,
      }));
      const moved = findProtectedSlotIssues(
        (await loadSlots(tx, tenant)).map(toSlotRecord), target,
        await slotsUsedOutside(tx, tenant, yearId, scopeSectionIds(version)),
      );
      if (moved.length) throw conflictError('The previous timetable cannot be restored because other classes still use periods it would change:', moved);

      const own = and(
        eq(timetableEntries.tenantId, tenant.id), eq(timetableEntries.academicYearId, yearId), eq(timetableEntries.versionId, version.id),
      );
      await tx.update(timetableEntries).set({ status: 'inactive' }).where(and(own, eq(timetableEntries.status, 'active')));
      await restoreSlots(tx, tenant, version.previousSlots);

      // The rows this publication switched off come back only if they still fit next to what is active now.
      const archived = and(
        eq(timetableEntries.tenantId, tenant.id), eq(timetableEntries.academicYearId, yearId),
        eq(timetableEntries.archivedByVersionId, version.id),
      );
      const comingBack = await tx.select({ id: timetableEntries.id, effectiveFrom: timetableEntries.effectiveFrom, ...bookingColumns })
        .from(timetableEntries).where(and(archived, eq(timetableEntries.status, 'inactive')));
      const returning = comingBack.map(toBooking);
      if (returning.length) {
        const slotTimes = new Map<string, SlotTime>(
          (await loadSlots(tx, tenant)).map((slot) => [slot.id.toString(), { startsAt: slot.startsAt, endsAt: slot.endsAt }]),
        );
        // a lesson that ended before every returning row starts cannot clash with them
        const earliest = comingBack.map((row) => row.effectiveFrom).sort()[0];
        const kept = await keptBookings(tx, tenant, yearId, { notEndedBefore: earliest, notIds: comingBack.map((row) => row.id) });
        const conflicts = await describeAll(tx, tenant, findConflicts(returning, kept, slotTimes));
        if (conflicts.length) throw conflictError('The previous timetable cannot be restored because it would double-book:', conflicts);
        await tx.update(timetableEntries).set({ status: 'active', archivedByVersionId: null }).where(and(archived, eq(timetableEntries.status, 'inactive')));
      }
      // rows switched back on by hand since the publication keep their state; only the leftover mark goes
      await tx.update(timetableEntries).set({ archivedByVersionId: null }).where(archived);

      await tx.update(timetableVersions).set({ status: 'archived' }).where(and(
        eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.id, version.id),
      ));
      if (previous?.status === 'archived') {
        await tx.update(timetableVersions).set({ status: 'published' }).where(and(
          eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.id, previous.id),
        ));
      }
    });
  } catch (error) {
    mapDatabaseConflict(error, 'restoring');
  }
}
