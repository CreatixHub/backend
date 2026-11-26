import { db } from '../../db';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import { Schedule, teacherLoads } from './engine/engine';
import { buildTeacherAvailability } from './engine/teacher-availability';
import { loadPlannerSnapshot, readPlannerSnapshot } from './planner.problem';
import { lockPlannerSettings } from './planner.settings';
import { buildVersionDetail, findPlannerVersion, fingerprintOf, requireDraft, saveVersionEntries, versionProblem } from './planner.versions';

type BlockInput = { blockId: string };
type PositionInput = BlockInput & { day: number; startNo: number };
type MoveResult = { ok: boolean; blockers: { message: string; kind: string; id?: string }[]; softDelta?: number | null };
type FitPosition = { day: number; first: number; ok: boolean; softDelta: number | null; reason: string | null; reasons: string[] };

async function inspectSchedule(tenant: TenantContext, yearId: bigint, id: bigint) {
  const version = await findPlannerVersion(db, tenant, yearId, id);
  const current = version.status === 'draft' ? await readPlannerSnapshot(tenant, yearId) : undefined;
  const problem = versionProblem(version, current);
  return { problem, schedule: Schedule.fromEntries(problem, version.entries, { seed: version.seed }) };
}

export async function getFit(tenant: TenantContext, yearId: bigint, id: bigint, { blockId }: BlockInput) {
  const { schedule } = await inspectSchedule(tenant, yearId, id);
  const positions: FitPosition[] = schedule.fitMap(blockId);
  return { blockId, positions };
}

export async function getTeacherAvailability(tenant: TenantContext, yearId: bigint, id: bigint, { blockId }: BlockInput) {
  const { problem, schedule } = await inspectSchedule(tenant, yearId, id);
  if (!schedule.blocks.has(blockId)) throw new HttpError(404, 'That lesson is not part of this timetable.');
  return buildTeacherAvailability({ problem, schedule, blockId, availability: problem.availability, plannedByTeacher: teacherLoads(problem) });
}

export async function checkMove(tenant: TenantContext, yearId: bigint, id: bigint, input: PositionInput): Promise<MoveResult> {
  const { schedule } = await inspectSchedule(tenant, yearId, id);
  return schedule.checkMove(input.blockId, input.day, input.startNo);
}

function editSchedule<T extends object>(
  tenant: TenantContext, yearId: bigint, id: bigint, edit: (schedule: Schedule) => T,
) {
  return db.transaction(async (tx) => {
    await lockPlannerSettings(tx, tenant, yearId);
    const version = await findPlannerVersion(tx, tenant, yearId, id, { forUpdate: true });
    requireDraft(version, 'editing');
    const current = await loadPlannerSnapshot(tx, tenant, yearId);
    // Saving would rebuild the entries against the CURRENT plan and silently drop placements that no longer fit.
    if (version.fingerprint !== fingerprintOf(current.problem)) {
      throw new HttpError(409, 'This draft is out of date with the current plan. Regenerate it, or duplicate it and regenerate the copy.');
    }
    const schedule = Schedule.fromEntries(current.problem, version.entries, { seed: version.seed });
    const result = edit(schedule);
    const updated = await saveVersionEntries(tx, tenant, yearId, id, schedule.entries());
    return { ...result, ...buildVersionDetail(updated, current, schedule) };
  });
}

function rejectBlocked(result: MoveResult) {
  if (!result.ok) throw new HttpError(409, result.blockers.map((blocker) => blocker.message).join(' '));
}

export function moveBlock(tenant: TenantContext, yearId: bigint, id: bigint, { blockId, day, startNo }: PositionInput) {
  return editSchedule(tenant, yearId, id, (schedule) => {
    const result: MoveResult = schedule.move(blockId, day, startNo);
    rejectBlocked(result);
    return { moved: true, softDelta: result.softDelta };
  });
}

export function placeBlock(tenant: TenantContext, yearId: bigint, id: bigint, { blockId, day, startNo }: PositionInput) {
  return editSchedule(tenant, yearId, id, (schedule) => {
    const result: MoveResult = schedule.placeAt(blockId, day, startNo);
    rejectBlocked(result);
    return { placed: true, softDelta: result.softDelta };
  });
}

export function unscheduleBlock(tenant: TenantContext, yearId: bigint, id: bigint, { blockId }: BlockInput) {
  return editSchedule(tenant, yearId, id, (schedule) => {
    if (!schedule.unschedule(blockId)) throw new HttpError(409, 'That lesson is locked or not on the timetable.');
    return { unscheduled: true };
  });
}

export function lockBlock(tenant: TenantContext, yearId: bigint, id: bigint, { blockId, locked }: BlockInput & { locked: boolean }) {
  return editSchedule(tenant, yearId, id, (schedule) => {
    if (!schedule.setLocked(blockId, locked)) throw new HttpError(404, 'That lesson is not on the timetable.');
    return { locked };
  });
}
