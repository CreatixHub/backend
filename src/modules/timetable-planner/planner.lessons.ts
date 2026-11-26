import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { classrooms, plannerLessons, roomGroups, sections, staff, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { SaveLessonInput } from './planner.schemas';
import { activeRoom, activeTeacher, changePlanner, sectionWithActiveClass, type PlannerTransaction } from './planner.settings';

export const activeSubject = (tenantId: bigint) =>
  and(eq(subjects.tenantId, tenantId), eq(subjects.status, 'active'), isNull(subjects.deletedAt));

type LessonRecord = Pick<typeof plannerLessons.$inferSelect, 'parts' | 'activityName' | 'syncGroup'> & {
  id: string | bigint;
  academicYearId: string | bigint;
  subjectId: string | bigint | null;
  sectionIds: (string | bigint)[];
};

export function toPlannerLesson(row: LessonRecord) {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    subjectId: row.subjectId?.toString() ?? null,
    sectionIds: row.sectionIds.map((id) => id.toString()),
    activityName: row.activityName,
    syncGroup: row.syncGroup,
    parts: row.parts,
  };
}
export type PlannerLesson = ReturnType<typeof toPlannerLesson>;

const lessonScope = (tenantId: bigint, yearId: bigint, id: bigint) =>
  and(eq(plannerLessons.id, id), eq(plannerLessons.tenantId, tenantId), eq(plannerLessons.academicYearId, yearId));

async function findLesson(tx: PlannerTransaction, tenantId: bigint, yearId: bigint, id: bigint) {
  const [row] = await tx.select().from(plannerLessons).where(lessonScope(tenantId, yearId, id));
  if (!row) throw new HttpError(404, 'Lesson not found');
  return row;
}

async function validateReferences(tx: PlannerTransaction, tenantId: bigint, input: SaveLessonInput) {
  const sectionIds = input.sectionIds.map(BigInt);
  const teacherIds = [...new Set(input.parts.flatMap((part) => part.teacherIds))].map(BigInt);
  const roomIds = [...new Set(input.parts.flatMap((part) => part.room.roomIds ?? []))].map(BigInt);
  const groupIds = [...new Set(input.parts.flatMap((part) => part.room.groupId ? [part.room.groupId] : []))].map(BigInt);
  const [classRows, subjectRows, teacherRows, roomRows, groupRows] = await Promise.all([
    tx.select({ id: sections.id }).from(sections).where(and(sectionWithActiveClass(tenantId), inArray(sections.id, sectionIds))),
    input.subjectId
      ? tx.select({ id: subjects.id }).from(subjects)
        .where(and(activeSubject(tenantId), eq(subjects.id, BigInt(input.subjectId))))
      : [],
    teacherIds.length
      ? tx.select({ id: staff.id }).from(staff).where(and(activeTeacher(tenantId), inArray(staff.id, teacherIds)))
      : [],
    roomIds.length
      ? tx.select({ id: classrooms.id }).from(classrooms).where(and(activeRoom(tenantId), inArray(classrooms.id, roomIds)))
      : [],
    groupIds.length
      ? tx.select({ id: roomGroups.id }).from(roomGroups)
        .where(and(eq(roomGroups.tenantId, tenantId), inArray(roomGroups.id, groupIds)))
      : [],
  ]);
  if (classRows.length !== sectionIds.length) throw new HttpError(400, 'One of the chosen classes no longer exists.');
  if (input.subjectId && !subjectRows.length) throw new HttpError(400, 'That subject no longer exists.');
  if (teacherRows.length !== teacherIds.length) throw new HttpError(400, 'One of the chosen teachers no longer exists.');
  if (roomRows.length !== roomIds.length) throw new HttpError(400, 'One of the chosen rooms no longer exists.');
  if (groupRows.length !== groupIds.length) throw new HttpError(400, 'That room group no longer exists.');
}

function toLessonValues(input: SaveLessonInput) {
  return {
    ...input,
    subjectId: input.subjectId ? BigInt(input.subjectId) : null,
    sectionIds: input.sectionIds.map(BigInt),
  };
}

export function createLesson(tenant: TenantContext, yearId: bigint, input: SaveLessonInput) {
  return changePlanner(tenant, yearId, async (tx) => {
    await validateReferences(tx, tenant.id, input);
    const [row] = await tx.insert(plannerLessons)
      .values({ ...toLessonValues(input), tenantId: tenant.id, academicYearId: yearId }).returning();
    return { data: toPlannerLesson(row) };
  });
}

export function updateLesson(tenant: TenantContext, yearId: bigint, id: bigint, input: SaveLessonInput) {
  return changePlanner(tenant, yearId, async (tx) => {
    await findLesson(tx, tenant.id, yearId, id);
    await validateReferences(tx, tenant.id, input);
    const [row] = await tx.update(plannerLessons).set(toLessonValues(input))
      .where(lessonScope(tenant.id, yearId, id)).returning();
    return { data: toPlannerLesson(row) };
  });
}

export function deleteLesson(tenant: TenantContext, yearId: bigint, id: bigint) {
  return changePlanner(tenant, yearId, async (tx) => {
    const [deleted] = await tx.delete(plannerLessons).where(lessonScope(tenant.id, yearId, id))
      .returning({ id: plannerLessons.id });
    if (!deleted) throw new HttpError(404, 'Lesson not found');
    return { data: undefined };
  });
}

export function copyLesson(tenant: TenantContext, yearId: bigint, id: bigint, sectionIds: string[]) {
  return changePlanner(tenant, yearId, async (tx) => {
    const { subjectId, activityName, syncGroup, parts, sectionIds: sourceSections } =
      toPlannerLesson(await findLesson(tx, tenant.id, yearId, id));
    const targets = sectionIds.filter((sectionId) => !sourceSections.includes(sectionId));
    if (!targets.length) throw new HttpError(400, 'Choose at least one other class to copy this lesson to.');
    await validateReferences(tx, tenant.id, { subjectId, activityName, syncGroup, parts, sectionIds: targets });

    const values = targets.map((sectionId) => ({
      ...toLessonValues({
        subjectId,
        activityName,
        syncGroup: syncGroup ? `${syncGroup}-${sectionId}` : null,
        sectionIds: [sectionId],
        parts: parts.map((part) => ({ ...part, id: randomUUID() })),
      }),
      tenantId: tenant.id,
      academicYearId: yearId,
    }));
    const rows = await tx.insert(plannerLessons).values(values).returning();
    return { data: rows.map(toPlannerLesson) };
  });
}
