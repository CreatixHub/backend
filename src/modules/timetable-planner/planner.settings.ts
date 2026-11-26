import { and, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  academicYears, classes, classrooms, organizations, plannerLessons, plannerSettings, roomGroups, sections, staff,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { Bell, BlockedSlot, RuleSet } from './engine/engine';
import type { AvailabilityKind, PlannerRules } from './planner.schemas';

export type PlannerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PlannerExecutor = Pick<typeof db, 'select' | 'insert'>;
type SettingsRow = typeof plannerSettings.$inferSelect;
type SettingsChanges = Partial<Pick<SettingsRow, 'bell' | 'rules' | 'availability' | 'excludedSectionIds'>>;

const settingsScope = (tenant: TenantContext, yearId: bigint) =>
  and(eq(plannerSettings.tenantId, tenant.id), eq(plannerSettings.academicYearId, yearId));

export const activeTeacher = (tenantId: bigint) =>
  and(eq(staff.tenantId, tenantId), eq(staff.staffType, 'teaching'), eq(staff.status, 'active'), isNull(staff.deletedAt));

export const activeClass = (tenantId: bigint) =>
  and(eq(classes.tenantId, tenantId), eq(classes.status, 'active'), isNull(classes.deletedAt));

export const activeSection = (tenantId: bigint) =>
  and(eq(sections.tenantId, tenantId), eq(sections.status, 'active'), isNull(sections.deletedAt));

export const activeRoom = (tenantId: bigint) =>
  and(eq(classrooms.tenantId, tenantId), eq(classrooms.status, 'active'), isNull(classrooms.deletedAt));

export function sectionWithActiveClass(tenantId: bigint) {
  return and(
    activeSection(tenantId),
    exists(db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, sections.classId), activeClass(tenantId)))),
  );
}

export async function ensurePlannerSettings(executor: PlannerExecutor, tenant: TenantContext, yearId: bigint) {
  const [existing] = await executor.select({ id: plannerSettings.id }).from(plannerSettings)
    .where(settingsScope(tenant, yearId));
  if (existing) return;

  // Callers normally resolve the year at the HTTP boundary; keep the on-demand insert tenant-safe
  // for internal callers too.
  const [year] = await executor.select({ id: academicYears.id }).from(academicYears)
    .where(and(eq(academicYears.id, yearId), eq(academicYears.tenantId, tenant.id)));
  if (!year) throw new HttpError(404, 'Academic year not found');
  await executor.insert(plannerSettings).values({ tenantId: tenant.id, academicYearId: yearId })
    .onConflictDoNothing({ target: [plannerSettings.tenantId, plannerSettings.academicYearId] });
}

async function lockSchoolPlanner(tx: PlannerTransaction, tenant: TenantContext, shared: boolean) {
  // The tenant lock always precedes the year lock. Year changes can run independently, but changes
  // to the shared room catalog must wait for all planner writes in the school, including publication.
  await tx.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.id, tenant.id)).for(shared ? 'share' : 'no key update');
}

export async function lockPlannerSettings(tx: PlannerTransaction, tenant: TenantContext, yearId: bigint, schoolWide = false) {
  await lockSchoolPlanner(tx, tenant, !schoolWide);
  await ensurePlannerSettings(tx, tenant, yearId);
  const [settings] = await tx.select().from(plannerSettings).where(settingsScope(tenant, yearId)).for('update');
  if (!settings) throw new HttpError(404, 'Planner settings not found');
  return settings;
}

async function bumpRevision(tx: PlannerTransaction, tenant: TenantContext, yearId?: bigint, changes?: SettingsChanges) {
  await tx.update(plannerSettings).set({ ...changes, revision: sql`${plannerSettings.revision} + 1` })
    .where(and(
      eq(plannerSettings.tenantId, tenant.id),
      yearId === undefined ? undefined : eq(plannerSettings.academicYearId, yearId),
    ));
}

export async function changePlanner<T>(
  tenant: TenantContext,
  yearId: bigint,
  mutate: (tx: PlannerTransaction, settings: SettingsRow) => Promise<{ data: T; changes?: SettingsChanges }>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const settings = await lockPlannerSettings(tx, tenant, yearId);
    const { data, changes } = await mutate(tx, settings);
    await bumpRevision(tx, tenant, yearId, changes);
    return data;
  });
}

export function saveBell(tenant: TenantContext, yearId: bigint, bell: Bell) {
  return changePlanner(tenant, yearId, async () => ({ data: bell, changes: { bell } }));
}

function ruleIds(rules: Record<string, RuleSet>) {
  return Object.keys(rules).filter((id) => /^[1-9]\d{0,17}$/.test(id)).map(BigInt);
}

function knownRules(rules: Record<string, RuleSet>, rows: { id: bigint }[]) {
  return Object.fromEntries(rows.map(({ id }) => [id.toString(), rules[id.toString()]] as const)
    .filter(([, set]) => Object.keys(set).length));
}

export function saveRules(tenant: TenantContext, yearId: bigint, input: PlannerRules) {
  return changePlanner(tenant, yearId, async (tx) => {
    const teacherIds = ruleIds(input.teachers);
    const sectionIds = ruleIds(input.sections);
    const [teachers, classes] = await Promise.all([
      teacherIds.length ? tx.select({ id: staff.id }).from(staff)
        .where(and(activeTeacher(tenant.id), inArray(staff.id, teacherIds))) : [],
      sectionIds.length ? tx.select({ id: sections.id }).from(sections)
        .where(and(sectionWithActiveClass(tenant.id), inArray(sections.id, sectionIds))) : [],
    ]);
    const rules = {
      defaults: input.defaults,
      teachers: knownRules(input.teachers, teachers),
      sections: knownRules(input.sections, classes),
    };
    return { data: rules, changes: { rules } };
  });
}

async function findAvailabilityTarget(tx: PlannerTransaction, tenant: TenantContext, kind: AvailabilityKind, id: bigint) {
  switch (kind) {
    case 'staff': {
      const [row] = await tx.select({ id: staff.id }).from(staff)
        .where(and(eq(staff.id, id), activeTeacher(tenant.id)));
      if (!row) throw new HttpError(404, 'Staff member not found');
      break;
    }
    case 'section': {
      const [row] = await tx.select({ id: sections.id }).from(sections)
        .where(and(eq(sections.id, id), sectionWithActiveClass(tenant.id)));
      if (!row) throw new HttpError(404, 'Class not found');
      break;
    }
    case 'room': {
      const [row] = await tx.select({ id: classrooms.id }).from(classrooms)
        .where(and(eq(classrooms.id, id), activeRoom(tenant.id)));
      if (!row) throw new HttpError(404, 'Room not found');
      break;
    }
  }
}

export function saveAvailability(
  tenant: TenantContext, yearId: bigint, kind: AvailabilityKind, id: bigint, blocked: BlockedSlot[],
) {
  return changePlanner(tenant, yearId, async (tx, settings) => {
    await findAvailabilityTarget(tx, tenant, kind, id);
    const targets = { ...settings.availability[kind] };
    if (blocked.length) targets[id.toString()] = blocked;
    else delete targets[id.toString()];
    return { data: { blocked }, changes: { availability: { ...settings.availability, [kind]: targets } } };
  });
}

export function saveSectionExcluded(tenant: TenantContext, yearId: bigint, id: bigint, excluded: boolean) {
  return changePlanner(tenant, yearId, async (tx, settings) => {
    await findAvailabilityTarget(tx, tenant, 'section', id);
    const next = new Set(settings.excludedSectionIds);
    if (excluded) next.add(id);
    else next.delete(id);
    return { data: { id: id.toString(), excluded }, changes: { excludedSectionIds: [...next] } };
  });
}

export function toPlannerRoom(row: { id: bigint | string; name: string | null; code: string;
  groupId: bigint | string | null; capacity: number | null; roomType: string }) {
  return {
    id: row.id.toString(),
    name: row.name || row.code,
    groupId: row.groupId?.toString() ?? null,
    capacity: row.capacity,
    type: row.roomType,
  };
}

const roomColumns = {
  id: classrooms.id, code: classrooms.code, name: classrooms.name, groupId: classrooms.groupId,
  capacity: classrooms.capacity, roomType: classrooms.roomType,
};

export function createRoomGroup(tenant: TenantContext, yearId: bigint, name: string) {
  return db.transaction(async (tx) => {
    await lockSchoolPlanner(tx, tenant, false);
    await ensurePlannerSettings(tx, tenant, yearId);
    const [duplicate] = await tx.select({ id: roomGroups.id }).from(roomGroups)
      .where(and(eq(roomGroups.tenantId, tenant.id), sql`lower(${roomGroups.name}) = lower(${name})`));
    if (duplicate) throw new HttpError(409, `A group called "${name}" already exists.`);
    const [group] = await tx.insert(roomGroups).values({ tenantId: tenant.id, name })
      .returning({ id: roomGroups.id, name: roomGroups.name });
    await bumpRevision(tx, tenant, yearId);
    return { ...group, id: group.id.toString() };
  });
}

export function deleteRoomGroup(tenant: TenantContext, yearId: bigint, id: bigint) {
  return db.transaction(async (tx) => {
    await lockSchoolPlanner(tx, tenant, false);
    await ensurePlannerSettings(tx, tenant, yearId);
    const groupScope = and(eq(roomGroups.tenantId, tenant.id), eq(roomGroups.id, id));
    const [group] = await tx.select({ id: roomGroups.id }).from(roomGroups).where(groupScope);
    if (!group) throw new HttpError(404, 'Room group not found');

    const requirement = JSON.stringify([{ room: { groupId: id.toString() } }]);
    const [used] = await tx.select({ id: plannerLessons.id }).from(plannerLessons)
      .where(and(eq(plannerLessons.tenantId, tenant.id), sql`${plannerLessons.parts} @> ${requirement}::jsonb`)).limit(1);
    if (used) throw new HttpError(409, 'This group is used by a lesson in the teaching plan. Change those lessons first.');
    const detached = await tx.update(classrooms).set({ groupId: null })
      .where(and(eq(classrooms.tenantId, tenant.id), eq(classrooms.groupId, id)))
      .returning({ status: classrooms.status, deletedAt: classrooms.deletedAt });
    await tx.delete(roomGroups).where(groupScope);
    await bumpRevision(tx, tenant, detached.some((room) => room.status === 'active' && room.deletedAt === null) ? undefined : yearId);
  });
}

export function saveRoomGroup(tenant: TenantContext, yearId: bigint, roomId: bigint, groupId: bigint | null) {
  return db.transaction(async (tx) => {
    await lockSchoolPlanner(tx, tenant, false);
    await ensurePlannerSettings(tx, tenant, yearId);
    const roomScope = and(eq(classrooms.id, roomId), activeRoom(tenant.id));
    const [room] = await tx.select(roomColumns).from(classrooms).where(roomScope).for('update');
    if (!room) throw new HttpError(404, 'Room not found');
    if (room.groupId === groupId) return toPlannerRoom(room);
    if (groupId !== null) {
      const [group] = await tx.select({ id: roomGroups.id }).from(roomGroups)
        .where(and(eq(roomGroups.tenantId, tenant.id), eq(roomGroups.id, groupId)));
      if (!group) throw new HttpError(400, 'That room group no longer exists.');
    }
    const [updated] = await tx.update(classrooms).set({ groupId }).where(roomScope).returning(roomColumns);
    await bumpRevision(tx, tenant);
    return toPlannerRoom(updated);
  });
}
