import { and, eq, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../../db';
import { classes, classrooms, plannerLessons, plannerSettings, roomGroups, sections, staff, staffSubjects, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import { analyze, DEFAULT_RULES, teacherLoads, type Problem } from './engine/engine';
import { activeSubject, toPlannerLesson } from './planner.lessons';
import { DAY_LABELS } from './planner.schemas';
import { activeClass, activeRoom, activeSection, ensurePlannerSettings, toPlannerRoom, type PlannerExecutor } from './planner.settings';

type Section = { id: string; name: string; classId: string; className: string; capacity: number };
type Subject = { id: string; name: string; code: string };
type Teacher = {
  id: string;
  name: string;
  active: boolean;
  staffType: string;
  primarySubjectId: string | null;
  additionalSubjectIds: string[];
  maxPeriodsPerWeek: number | null;
};
type Room = { id: string; name: string | null; code: string; groupId: string | null; roomType: string; capacity: number | null };
type LessonRow = Parameters<typeof toPlannerLesson>[0];

// A single statement gives every catalogue and settings field the same PostgreSQL snapshot, also
// when the caller uses a READ COMMITTED transaction holding the settings lock. Cast IDs to text
// inside the JSON aggregation so pg never decodes them as JavaScript numbers.
function jsonRows<Row>(query: SQLWrapper) {
  return sql<Row[]>`(select coalesce(jsonb_agg(to_jsonb(item) order by item.id::bigint), '[]'::jsonb)
    from (${query}) as item)`;
}

export async function loadPlannerSnapshot(executor: PlannerExecutor, tenant: TenantContext, yearId: bigint) {
  const [snapshot] = await executor.select({
    revision: plannerSettings.revision,
    bell: plannerSettings.bell,
    rules: plannerSettings.rules,
    availability: plannerSettings.availability,
    excludedSectionIds: plannerSettings.excludedSectionIds,
    sections: jsonRows<Section>(executor.select({
      id: sql`${sections.id}::text`.as('id'),
      name: sections.name,
      classId: sql`${sections.classId}::text`.as('classId'),
      className: sql`${classes.name}`.as('className'),
      capacity: sections.capacity,
    }).from(sections).innerJoin(classes, and(eq(classes.id, sections.classId), activeClass(tenant.id)))
      .where(activeSection(tenant.id))),
    teachers: jsonRows<Teacher>(executor.select({
      id: sql`${staff.id}::text`.as('id'),
      name: sql`coalesce(nullif(${staff.fullName}, ''), nullif(concat_ws(' ', ${staff.firstName}, ${staff.lastName}), ''), ${staff.id}::text)`.as('name'),
      active: sql`${staff.status} = 'active' and ${isNull(staff.deletedAt)}`.as('active'),
      staffType: sql`${staff.staffType}`.as('staffType'),
      primarySubjectId: sql`${staff.primarySubjectId}::text`.as('primarySubjectId'),
      maxPeriodsPerWeek: sql`${staff.maxPeriodsPerWeek}`.as('maxPeriodsPerWeek'),
      additionalSubjectIds: sql`array(
        select ${staffSubjects.subjectId}::text
        from ${staffSubjects}
        where ${and(eq(staffSubjects.staffId, staff.id), eq(staffSubjects.tenantId, tenant.id))}
        order by ${staffSubjects.subjectId}
      )`.as('additionalSubjectIds'),
    }).from(staff).where(eq(staff.tenantId, tenant.id))),
    subjects: jsonRows<Subject>(executor.select({
      id: sql`${subjects.id}::text`.as('id'),
      name: subjects.name,
      code: subjects.code,
    }).from(subjects).where(activeSubject(tenant.id))),
    rooms: jsonRows<Room>(executor.select({
      id: sql`${classrooms.id}::text`.as('id'),
      name: classrooms.name,
      code: classrooms.code,
      groupId: sql`${roomGroups.id}::text`.as('groupId'),
      capacity: classrooms.capacity,
      roomType: sql`${classrooms.roomType}`.as('roomType'),
    }).from(classrooms).leftJoin(roomGroups, and(eq(roomGroups.id, classrooms.groupId), eq(roomGroups.tenantId, tenant.id)))
      .where(activeRoom(tenant.id))),
    roomGroups: jsonRows<{ id: string; name: string }>(executor.select({
      id: sql`${roomGroups.id}::text`.as('id'),
      name: roomGroups.name,
    }).from(roomGroups).where(eq(roomGroups.tenantId, tenant.id))),
    lessons: jsonRows<LessonRow>(executor.select({
      id: sql`${plannerLessons.id}::text`.as('id'),
      academicYearId: sql`${plannerLessons.academicYearId}::text`.as('academicYearId'),
      subjectId: sql`${plannerLessons.subjectId}::text`.as('subjectId'),
      activityName: sql`${plannerLessons.activityName}`.as('activityName'),
      sectionIds: sql`${plannerLessons.sectionIds}::text[]`.as('sectionIds'),
      syncGroup: sql`${plannerLessons.syncGroup}`.as('syncGroup'),
      parts: plannerLessons.parts,
    }).from(plannerLessons).where(and(eq(plannerLessons.tenantId, tenant.id), eq(plannerLessons.academicYearId, yearId)))),
  }).from(plannerSettings).where(and(eq(plannerSettings.tenantId, tenant.id), eq(plannerSettings.academicYearId, yearId)));
  if (!snapshot) throw new HttpError(404, 'Planner settings not found');

  const { revision, bell, rules, availability, roomGroups: groups } = snapshot;
  const lessons = snapshot.lessons.map(toPlannerLesson);
  const rooms = snapshot.rooms.map(toPlannerRoom);
  const excluded = new Set(snapshot.excludedSectionIds.map((id) => id.toString()));
  const sectionLookups = snapshot.sections.map((section) => ({ ...section, excluded: excluded.has(section.id) }));
  const subjectsById = new Map(snapshot.subjects.map((subject) => [subject.id, subject.name]));
  const staffLookups = snapshot.teachers.filter((teacher) => teacher.active && teacher.staffType === 'teaching').map((teacher) => {
    const primarySubjectId = teacher.primarySubjectId && subjectsById.has(teacher.primarySubjectId) ? teacher.primarySubjectId : null;
    const subjectIds = new Set(teacher.additionalSubjectIds.filter((id) => subjectsById.has(id)));
    return {
      id: teacher.id,
      name: teacher.name,
      staffType: teacher.staffType,
      primarySubjectId,
      subjectIds: primarySubjectId ? [primarySubjectId, ...[...subjectIds].filter((id) => id !== primarySubjectId)] : [...subjectIds],
      maxPeriodsPerWeek: teacher.maxPeriodsPerWeek,
    };
  });

  const activeLessons = lessons.flatMap((lesson) => {
    const sectionIds = lesson.sectionIds.filter((id) => !excluded.has(id));
    if (!sectionIds.length) return [];
    const subjectName = lesson.subjectId ? subjectsById.get(lesson.subjectId) : undefined;
    return [{ ...lesson, sectionIds, subjectName, subjectMissing: Boolean(lesson.subjectId && !subjectName) }];
  });
  const referencedTeachers = new Set(activeLessons.flatMap((lesson) => lesson.parts.flatMap((part) => part.teacherIds)));
  const inactiveTeacherNames = Object.fromEntries(snapshot.teachers
    .filter((teacher) => referencedTeachers.has(teacher.id) && (!teacher.active || teacher.staffType !== 'teaching'))
    .map((teacher) => [teacher.id, teacher.name]));

  const problem: Problem = {
    days: [...new Set(bell.dayTypes.flatMap((dayType) => dayType.days))].sort((a, b) => a - b),
    bell,
    sections: sectionLookups.filter((section) => !section.excluded)
      .map(({ id, name, className, capacity }) => ({ id, name, className, capacity })),
    staff: staffLookups.map(({ id, name, primarySubjectId, subjectIds, maxPeriodsPerWeek }) =>
      ({ id, name, primarySubjectId, subjectIds, maxPeriodsPerWeek })),
    rooms,
    availability,
    rules,
    lessons: activeLessons,
    inactiveTeacherNames,
  };

  return {
    revision, problem, bell, rooms, roomGroups: groups, availability, rules, lessons,
    lookups: { sections: sectionLookups, staff: staffLookups, subjects: snapshot.subjects, defaultRules: DEFAULT_RULES },
  };
}

export async function readPlannerSnapshot(tenant: TenantContext, yearId: bigint) {
  await ensurePlannerSettings(db, tenant, yearId);
  return loadPlannerSnapshot(db, tenant, yearId);
}

export async function loadProblem(tenant: TenantContext, yearId: bigint): Promise<Problem> {
  return (await readPlannerSnapshot(tenant, yearId)).problem;
}

export async function getPlannerState(tenant: TenantContext, yearId: bigint) {
  const { problem, lookups, ...state } = await readPlannerSnapshot(tenant, yearId);
  const planned = teacherLoads(problem);
  return {
    ...state,
    dayLabels: DAY_LABELS,
    sampleLoaded: false,
    lookups: {
      ...lookups,
      staff: lookups.staff.map((teacher) => ({ ...teacher, plannedPeriods: planned.get(teacher.id) ?? 0 })),
    },
  };
}

export async function getReadiness(tenant: TenantContext, yearId: bigint) {
  return analyze(await loadProblem(tenant, yearId));
}
