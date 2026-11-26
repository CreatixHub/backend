import { createHash, randomInt } from 'node:crypto';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { timetableVersions } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { TenantContext } from '../../lib/tenant';
import { analyze, Schedule, type GenerateOutput, type Problem, type ScheduleEntry } from './engine/engine';
import { GenerationBusyError, GenerationTimeoutError, generateInWorker } from './engine/run-generate';
import { loadPlannerSnapshot, readPlannerSnapshot } from './planner.problem';
import { DAY_LABELS } from './planner.schemas';
import { lockPlannerSettings, type PlannerExecutor, type PlannerTransaction } from './planner.settings';

export type PlannerVersion = typeof timetableVersions.$inferSelect;
type Snapshot = Awaited<ReturnType<typeof loadPlannerSnapshot>>;
type VersionPlan = Pick<PlannerVersion, 'problem' | 'bell' | 'fingerprint' | 'settingsRevision'>;
export type GenerateVersionInput = { name?: string; seed?: number; budgetMs?: number; versionId?: string; keepPlaced?: boolean };

const versionScope = (tenant: TenantContext, yearId: bigint, id?: bigint) =>
  and(eq(timetableVersions.tenantId, tenant.id), eq(timetableVersions.academicYearId, yearId),
    id === undefined ? undefined : eq(timetableVersions.id, id));

const planChanged = () => new HttpError(409, 'The plan changed while the timetable was being generated. Generate again.');

export function fingerprintOf(problem: Problem): string {
  // JSONB does not preserve object key order. Array order is preserved because the engine can use it
  // to resolve ties and because the order of the bell periods is significant.
  const canonical = JSON.stringify(problem, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function selectPlannerVersion(
  executor: PlannerExecutor, tenant: TenantContext, yearId: bigint, id: bigint, forUpdate: boolean,
) {
  const query = executor.select().from(timetableVersions).where(versionScope(tenant, yearId, id));
  const [version] = await (forUpdate ? query.for('update') : query);
  return version as PlannerVersion | undefined;
}

export async function findPlannerVersion(
  executor: PlannerExecutor, tenant: TenantContext, yearId: bigint, id: bigint, { forUpdate = false } = {},
) {
  const version = await selectPlannerVersion(executor, tenant, yearId, id, forUpdate);
  if (!version) throw new HttpError(404, 'Timetable was not found.');
  return version;
}

export function requireDraft(version: PlannerVersion, action: string) {
  if (version.status !== 'draft') throw new HttpError(409, `Make a draft copy before ${action}.`);
}

export function versionSummary(version: PlannerVersion) {
  return {
    id: version.id,
    name: version.name,
    status: version.status,
    academicYearId: version.academicYearId,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    generatedAt: version.generatedAt,
    publishedAt: version.publishedAt,
    seed: version.seed,
    lessonCount: new Set(version.entries.map((entry) => entry.blockId)).size,
    canRestore: version.status === 'published' && version.previousSlots !== null,
  };
}

export function versionProblem(version: PlannerVersion, currentSnapshot?: Snapshot): Problem {
  return version.status === 'draft' && currentSnapshot ? currentSnapshot.problem : version.problem;
}

export function buildVersionDetail(
  version: PlannerVersion, currentSnapshot?: Snapshot,
  schedule = Schedule.fromEntries(versionProblem(version, currentSnapshot), version.entries, { seed: version.seed }),
) {
  const problem = versionProblem(version, currentSnapshot);
  const entries: ScheduleEntry[] = schedule.entries();
  const dropped: { blockId: string; reason: string }[] = schedule.dropped;
  const criticalViolations: string[] = Array.from(
    schedule.criticalViolations().values(), (violation) => schedule.describeCritical(violation),
  );
  return {
    version: versionSummary(version),
    bell: problem.bell,
    days: problem.days,
    dayLabels: DAY_LABELS,
    entries,
    unplaced: schedule.unplaced(),
    stats: schedule.stats(),
    insights: schedule.insights(),
    workload: schedule.workload(),
    emptyPeriods: schedule.emptyPeriods(),
    dropped,
    requiresRegeneration: version.status === 'draft' && version.fingerprint !== fingerprintOf(problem),
    criticalViolations,
  };
}

export async function listPlannerVersions(tenant: TenantContext, yearId: bigint) {
  const versions = await db.select().from(timetableVersions).where(versionScope(tenant, yearId))
    .orderBy(desc(timetableVersions.id));
  return versions.map(versionSummary);
}

export async function getVersionDetail(tenant: TenantContext, yearId: bigint, id: bigint) {
  const version = await findPlannerVersion(db, tenant, yearId, id);
  const snapshot = version.status === 'draft' ? await readPlannerSnapshot(tenant, yearId) : undefined;
  return buildVersionDetail(version, snapshot);
}

export async function getVersionReports(tenant: TenantContext, yearId: bigint, id: bigint) {
  const { insights, workload } = await getVersionDetail(tenant, yearId, id);
  return { insights, workload };
}

function requireReady(problem: Problem) {
  const readiness = analyze(problem);
  if (!readiness.ok) {
    const issues = readiness.blocking.length;
    throw new HttpError(409, `Fix ${issues} problem${issues === 1 ? '' : 's'} before generating: ${readiness.blocking[0].message}`);
  }
}

function snapshotPlan(snapshot: Snapshot): VersionPlan {
  return {
    problem: snapshot.problem,
    bell: snapshot.bell,
    settingsRevision: snapshot.revision,
    fingerprint: fingerprintOf(snapshot.problem),
  };
}

async function insertDraft(
  tx: PlannerTransaction, tenant: TenantContext, yearId: bigint, actorId: bigint,
  draft: VersionPlan & Pick<PlannerVersion, 'entries' | 'seed' | 'generatedAt'> & { name?: string },
) {
  let name = draft.name;
  if (name === undefined) {
    const [existing] = await tx.select({ total: count() }).from(timetableVersions).where(versionScope(tenant, yearId));
    name = `Draft ${existing.total + 1}`;
  }
  const [version] = await tx.insert(timetableVersions)
    .values({ ...draft, name, tenantId: tenant.id, academicYearId: yearId, createdBy: actorId }).returning();
  return version;
}

export function createBlankVersion(tenant: TenantContext, yearId: bigint, actorId: bigint, name?: string) {
  return db.transaction(async (tx) => {
    await lockPlannerSettings(tx, tenant, yearId);
    const snapshot = await loadPlannerSnapshot(tx, tenant, yearId);
    requireReady(snapshot.problem);
    const version = await insertDraft(tx, tenant, yearId, actorId, {
      ...snapshotPlan(snapshot), name, seed: 1, entries: [], generatedAt: null,
    });
    return buildVersionDetail(version, snapshot);
  });
}

export function duplicateVersion(tenant: TenantContext, yearId: bigint, actorId: bigint, id: bigint) {
  return db.transaction(async (tx) => {
    await lockPlannerSettings(tx, tenant, yearId);
    const original = await findPlannerVersion(tx, tenant, yearId, id, { forUpdate: true });
    const { problem, bell, fingerprint, settingsRevision, entries, seed, generatedAt } = original;
    const copy = await insertDraft(tx, tenant, yearId, actorId, {
      problem, bell, fingerprint, settingsRevision, entries, seed, generatedAt, name: `${original.name} (copy)`,
    });
    return buildVersionDetail(copy, await loadPlannerSnapshot(tx, tenant, yearId));
  });
}

async function updateDraft(
  tx: PlannerTransaction, tenant: TenantContext, yearId: bigint, id: bigint,
  changes: Partial<VersionPlan & Pick<PlannerVersion, 'entries' | 'seed' | 'generatedAt' | 'name'>>,
) {
  const [updated] = await tx.update(timetableVersions)
    .set({ ...changes, editRevision: sql`${timetableVersions.editRevision} + 1` })
    .where(versionScope(tenant, yearId, id)).returning();
  return updated;
}

export function saveVersionEntries(
  tx: PlannerTransaction, tenant: TenantContext, yearId: bigint, id: bigint, entries: ScheduleEntry[],
) {
  return updateDraft(tx, tenant, yearId, id, { entries });
}

export function renameVersion(tenant: TenantContext, yearId: bigint, id: bigint, name: string) {
  return db.transaction(async (tx) => {
    await lockPlannerSettings(tx, tenant, yearId);
    const version = await findPlannerVersion(tx, tenant, yearId, id, { forUpdate: true });
    requireDraft(version, 'renaming');
    return versionSummary(await updateDraft(tx, tenant, yearId, id, { name }));
  });
}

export function deleteVersion(tenant: TenantContext, yearId: bigint, id: bigint) {
  return db.transaction(async (tx) => {
    await lockPlannerSettings(tx, tenant, yearId);
    const version = await findPlannerVersion(tx, tenant, yearId, id, { forUpdate: true });
    if (version.status !== 'draft') throw new HttpError(409, 'Only draft timetables can be deleted.');
    await tx.delete(timetableVersions).where(versionScope(tenant, yearId, id));
  });
}

export async function generateVersion(tenant: TenantContext, yearId: bigint, actorId: bigint, input: GenerateVersionInput) {
  const original = input.versionId === undefined ? undefined : await findPlannerVersion(db, tenant, yearId, BigInt(input.versionId));
  if (original) requireDraft(original, 'regenerating');

  const snapshot = await readPlannerSnapshot(tenant, yearId);
  const plan = snapshotPlan(snapshot);
  requireReady(plan.problem);
  const seed = input.seed ?? randomInt(2 ** 31);
  const budgetMs = Math.min(15_000, Math.max(200, input.budgetMs ?? 3000));
  const entries = original?.entries ?? [];
  const locks = new Map(entries.map((entry) => [entry.blockId, Boolean(entry.locked)]));
  const lockedEntries = input.keepPlaced ? entries.map((entry) => ({ ...entry, locked: true })) : entries;

  let result: GenerateOutput;
  try {
    result = await generateInWorker(plan.problem, { seed, budgetMs, lockedEntries }, { timeoutMs: budgetMs + 40_000 });
  } catch (error) {
    if (error instanceof GenerationBusyError) throw new HttpError(429, error.message);
    // Log the real cause (never the problem payload); the client only gets a generic message.
    logger.error({ err: error, tenantId: String(tenant.id), versionId: original ? String(original.id) : null }, 'Timetable generation failed');
    if (error instanceof GenerationTimeoutError) {
      throw new HttpError(504, 'Generating the timetable took too long. Try a smaller plan or try again.');
    }
    throw new HttpError(500, 'Timetable generation failed. Please try again.');
  }

  return db.transaction(async (tx) => {
    const settings = await lockPlannerSettings(tx, tenant, yearId);
    if (settings.revision !== plan.settingsRevision) throw planChanged();
    const current = original && await selectPlannerVersion(tx, tenant, yearId, original.id, true);
    if (original && (!current || current.status !== 'draft' || current.editRevision !== original.editRevision)) {
      throw new HttpError(409, 'The draft changed while the timetable was being generated. Generate again.');
    }
    const latest = await loadPlannerSnapshot(tx, tenant, yearId);
    if (fingerprintOf(latest.problem) !== plan.fingerprint) throw planChanged();

    const generated = {
      ...plan, seed, generatedAt: new Date(),
      // The engine leaves the temporary locks on blocks it kept, while newly placed blocks are unlocked.
      entries: result.entries.map((entry) => input.keepPlaced && entry.locked && locks.has(entry.blockId)
        ? { ...entry, locked: locks.get(entry.blockId) }
        : entry),
    };
    const version = current
      ? await updateDraft(tx, tenant, yearId, current.id, generated)
      : await insertDraft(tx, tenant, yearId, actorId, { ...generated, name: input.name });
    const { ms, iterations, moves } = result.stats;
    return { ...buildVersionDetail(version, latest), generation: { ms, iterations, moves, seed, warnings: result.warnings } };
  });
}
