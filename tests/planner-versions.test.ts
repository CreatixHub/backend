import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db';
import { timetableVersions } from '../src/db/schema';
import { generate, type ScheduleEntry } from '../src/modules/timetable-planner/engine/engine';
import * as worker from '../src/modules/timetable-planner/engine/run-generate';
import { createPlannerSchool } from './helpers/plannerSchool';
import { plannerSampleProblem } from './helpers/plannerSample';

const base = '/api/timetable-planner';
const versions = `${base}/versions`;

async function smallSchool(tag: string) {
  const sample = plannerSampleProblem();
  const teacher = sample.staff[0];
  sample.sections = sample.sections.slice(0, 2);
  sample.staff = [teacher];
  sample.lessons = sample.sections.map((section, index) => ({
    ...sample.lessons.find((lesson) => lesson.sectionIds.includes(section.id) && lesson.subjectId === teacher.primarySubjectId)!,
    id: String(index + 1),
    parts: [{ ...sample.lessons[0].parts[0], pattern: [{ count: 1, length: 1 }] }],
  }));
  return createPlannerSchool(tag, sample);
}

afterEach(() => vi.restoreAllMocks());

describe('timetable planner versions', () => {
  it('generates all 200 periods in the sample school through the worker', async () => {
    const { agent, academicYearId, teacherIds } = await createPlannerSchool('planner-generate');
    const response = await agent.post(`${base}/generate`).send({ name: 'November draft', seed: 42, budgetMs: 200 });
    expect(response.status, response.body.message).toBe(201);
    const detail = response.body.data;
    expect(detail.version).toEqual(expect.objectContaining({ name: 'November draft', academicYearId, status: 'draft', lessonCount: 200 }));
    expect(detail.entries).toHaveLength(200);
    expect(detail.unplaced).toEqual([]);
    expect(detail.criticalViolations).toEqual([]);
    expect(detail.stats).toEqual(expect.objectContaining({ totalPeriods: 200, placedPeriods: 200 }));
    expect(detail.generation).toEqual(expect.objectContaining({ seed: 42, warnings: [] }));
    for (const [index, teacherId] of teacherIds.entries()) {
      const entries = (detail.entries as ScheduleEntry[]).filter((entry) => entry.teacherIds.includes(teacherId));
      expect(entries).toHaveLength(index < 5 ? 28 : 30);
      for (const day of [1, 2, 3, 4, 5]) expect(entries.filter((entry) => entry.day === day).length).toBeLessThanOrEqual(7);
    }

    const { id } = detail.version;
    const reports = await agent.get(`${versions}/${id}/reports`);
    expect(reports.status).toBe(200);
    expect(reports.body.data.workload).toHaveLength(7);
    expect((await agent.get(`${base}/state`)).body.data.versions).toEqual([detail.version]);
  });

  it('discards worker output after a settings revision changes and stores no version', async () => {
    const { agent, lessonIds } = await smallSchool('planner-stale-revision');
    const state = (await agent.get(`${base}/state`)).body.data;
    const lesson = state.lessons[0];
    vi.spyOn(worker, 'generateInWorker').mockImplementationOnce(async (problem, options) => {
      const edit = await agent.patch(`${base}/lessons/${lessonIds[0]}`).send({
        ...lesson, parts: [{ ...lesson.parts[0], pattern: [{ count: 2, length: 1 }] }],
      });
      expect(edit.status, edit.body.message).toBe(200);
      return generate(problem, options);
    });
    const response = await agent.post(`${base}/generate`).send({ seed: 1, budgetMs: 200 });
    expect(response.status, response.body.message).toBe(409);
    expect(response.body.message).toContain('The plan changed');
    expect((await agent.get(versions)).body.data).toEqual([]);
  });

  it('discards worker output after a catalogue change that leaves the settings revision alone', async () => {
    const { agent, teacherIds } = await smallSchool('planner-stale-catalogue');
    const revision = (await agent.get(`${base}/state`)).body.data.revision;
    vi.spyOn(worker, 'generateInWorker').mockImplementationOnce(async (problem, options) => {
      const edit = await agent.patch(`/api/staff/${teacherIds[0]}`).send({ status: 'suspended' });
      expect(edit.status, edit.body.message).toBe(200);
      return generate(problem, options);
    });
    const response = await agent.post(`${base}/generate`).send({ seed: 1, budgetMs: 200 });
    expect(response.status, response.body.message).toBe(409);
    expect(response.body.message).toContain('The plan changed');
    expect((await agent.get(`${base}/state`)).body.data.revision).toBe(revision);
    expect((await agent.get(versions)).body.data).toEqual([]);
  });

  it('does not overwrite changes to a draft made while its regeneration is running', async () => {
    const { agent } = await smallSchool('planner-stale-draft');
    const blank = await agent.post(versions).send({ name: 'Initial draft' });
    expect(blank.status, blank.body.message).toBe(201);
    const { id } = blank.body.data.version;
    expect(blank.body.data.entries).toEqual([]);
    vi.spyOn(worker, 'generateInWorker').mockImplementationOnce(async (problem, options) => {
      const rename = await agent.patch(`${versions}/${id}`).send({ name: 'Edited during generation' });
      expect(rename.status, rename.body.message).toBe(200);
      return generate(problem, options);
    });
    const response = await agent.post(`${base}/generate`).send({ versionId: id, seed: 2, budgetMs: 200 });
    expect(response.status, response.body.message).toBe(409);
    expect(response.body.message).toContain('The draft changed');
    const detail = (await agent.get(`${versions}/${id}`)).body.data;
    expect(detail.version.name).toBe('Edited during generation');
    expect(detail.entries).toEqual([]);
  });

  it('reports named teacher clashes in fit, check-move and move, then unschedules unlocked blocks', async () => {
    const { agent } = await smallSchool('planner-manual');
    const blank = await agent.post(versions).send({});
    expect(blank.status, blank.body.message).toBe(201);
    expect(blank.body.data.entries).toEqual([]);
    const path = `${versions}/${blank.body.data.version.id}`;
    const [first, second] = blank.body.data.unplaced.map((entry: { blockId: string }) => entry.blockId);
    const firstPlacement = await agent.post(`${path}/place`).send({ blockId: first, day: 1, startNo: 1 });
    expect(firstPlacement.status, firstPlacement.body.message).toBe(200);
    const secondPlacement = await agent.post(`${path}/place`).send({ blockId: second, day: 1, startNo: 2 });
    expect(secondPlacement.status, secondPlacement.body.message).toBe(200);

    const fit = await agent.get(`${path}/fit`).query({ blockId: second });
    expect(fit.status).toBe(200);
    expect(fit.body.data.positions).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: 1, first: 1, ok: false, reason: expect.stringContaining('Asha Kumar') }),
    ]));
    const move = { blockId: second, day: 1, startNo: 1 };
    const check = await agent.post(`${path}/check-move`).send(move);
    expect(check.status).toBe(200);
    expect(check.body.data).toEqual(expect.objectContaining({
      ok: false,
      blockers: [expect.objectContaining({ kind: 'teacher', message: expect.stringContaining('Asha Kumar') })],
    }));
    const rejected = await agent.post(`${path}/move`).send(move);
    expect(rejected.status).toBe(409);
    expect(rejected.body.message).toContain('Asha Kumar');
    expect((await agent.post(`${path}/move`).send({ ...move, startNo: 3 })).status).toBe(200);
    const removed = await agent.post(`${path}/unschedule`).send({ blockId: second });
    expect(removed.status).toBe(200);
    expect(removed.body.data.entries.map((entry: ScheduleEntry) => entry.blockId)).toEqual([first]);
  });

  it('preserves placements and restores their original lock flags when filling an existing draft', async () => {
    const { agent } = await smallSchool('planner-keep-placed');
    const blank = await agent.post(versions).send({});
    expect(blank.status, blank.body.message).toBe(201);
    const { id } = blank.body.data.version;
    const path = `${versions}/${id}`;
    const [locked, unlocked] = blank.body.data.unplaced.map((entry: { blockId: string }) => entry.blockId);
    expect((await agent.post(`${path}/place`).send({ blockId: locked, day: 2, startNo: 3 })).status).toBe(200);
    expect((await agent.post(`${path}/lock`).send({ blockId: locked, locked: true })).status).toBe(200);
    expect((await agent.post(`${path}/place`).send({ blockId: unlocked, day: 3, startNo: 5 })).status).toBe(200);
    const response = await agent.post(`${base}/generate`).send({ versionId: id, seed: 2, budgetMs: 200, keepPlaced: true });
    expect(response.status, response.body.message).toBe(201);
    expect(response.body.data.version.id).toBe(id);
    expect(response.body.data.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ blockId: locked, day: 2, startNo: 3, locked: true }),
      expect.objectContaining({ blockId: unlocked, day: 3, startNo: 5, locked: false }),
    ]));
    expect((await agent.get(versions)).body.data).toHaveLength(1);
  });

  it('marks a draft stale after a bell edit and copies it as a stale draft', async () => {
    const { agent } = await smallSchool('planner-bell-fingerprint');
    const blank = await agent.post(versions).send({ name: 'Before bell change' });
    expect(blank.status, blank.body.message).toBe(201);
    const { id } = blank.body.data.version;
    expect(blank.body.data.requiresRegeneration).toBe(false);
    expect((await agent.patch(`${base}/bell`).send({ dayTypes: [{ ...blank.body.data.bell.dayTypes[0], days: [1, 2, 3, 4] }] })).status).toBe(200);
    expect((await agent.get(`${versions}/${id}`)).body.data.requiresRegeneration).toBe(true);
    const copy = await agent.post(`${versions}/${id}/duplicate`).send({});
    expect(copy.status, copy.body.message).toBe(201);
    expect(copy.body.data.version).toEqual(expect.objectContaining({ name: 'Before bell change (copy)', status: 'draft' }));
    expect(copy.body.data.version.id).not.toBe(id);
    expect(copy.body.data.requiresRegeneration).toBe(true);
    expect((await agent.delete(`${versions}/${copy.body.data.version.id}`)).status).toBe(204);
  });

  it('moving a lesson in a stale draft returns 409 and leaves the entries unchanged', async () => {
    const { agent, tenantId, academicYearId } = await smallSchool('planner-stale-edit');
    const blank = await agent.post(versions).send({});
    expect(blank.status, blank.body.message).toBe(201);
    const { id } = blank.body.data.version;
    const path = `${versions}/${id}`;
    const [first, second] = blank.body.data.unplaced.map((entry: { blockId: string }) => entry.blockId);
    // Friday (day 5) disappears from the bell below, so a save against the new plan would drop this placement.
    expect((await agent.post(`${path}/place`).send({ blockId: first, day: 5, startNo: 1 })).status).toBe(200);
    const storedEntries = async () => (await db.select({ entries: timetableVersions.entries }).from(timetableVersions).where(and(
      eq(timetableVersions.id, BigInt(id)), eq(timetableVersions.tenantId, tenantId),
      eq(timetableVersions.academicYearId, BigInt(academicYearId)),
    )))[0].entries;
    const before = await storedEntries();
    expect(before).toEqual([expect.objectContaining({ blockId: first, day: 5, startNo: 1 })]);

    expect((await agent.patch(`${base}/bell`).send({ dayTypes: [{ ...blank.body.data.bell.dayTypes[0], days: [1, 2, 3, 4] }] })).status).toBe(200);
    expect((await agent.get(path)).body.data.requiresRegeneration).toBe(true);

    const message = 'This draft is out of date with the current plan. Regenerate it, or duplicate it and regenerate the copy.';
    const move = await agent.post(`${path}/move`).send({ blockId: first, day: 1, startNo: 1 });
    expect(move.status).toBe(409);
    expect(move.body.message).toBe(message);
    for (const [action, body] of [
      ['place', { blockId: second, day: 1, startNo: 2 }],
      ['unschedule', { blockId: first }],
      ['lock', { blockId: first, locked: true }],
    ] as const) {
      const response = await agent.post(`${path}/${action}`).send(body);
      expect(response.status, action).toBe(409);
      expect(response.body.message).toBe(message);
    }
    expect(await storedEntries()).toEqual(before);
  });

  it('read-only fit works on a stale draft', async () => {
    const { agent } = await smallSchool('planner-stale-fit');
    const blank = await agent.post(versions).send({});
    expect(blank.status, blank.body.message).toBe(201);
    const { id } = blank.body.data.version;
    const blockId = blank.body.data.unplaced[0].blockId;
    expect((await agent.patch(`${base}/bell`).send({ dayTypes: [{ ...blank.body.data.bell.dayTypes[0], days: [1, 2, 3, 4] }] })).status).toBe(200);
    expect((await agent.get(`${versions}/${id}`)).body.data.requiresRegeneration).toBe(true);
    const fit = await agent.get(`${versions}/${id}/fit`).query({ blockId });
    expect(fit.status, fit.body.message).toBe(200);
    expect(fit.body.data.positions.length).toBeGreaterThan(0);
    expect((await agent.post(`${versions}/${id}/check-move`).send({ blockId, day: 1, startNo: 1 })).status).toBe(200);
  });

  it('keeps published versions read-only and displays teacher availability from the saved plan', async () => {
    const { agent, tenantId, academicYearId, teacherIds } = await smallSchool('planner-published-read');
    const result = await agent.post(`${base}/generate`).send({ seed: 3, budgetMs: 200 });
    expect(result.status, result.body.message).toBe(201);
    const { id } = result.body.data.version;
    const blockId = result.body.data.entries[0].blockId;
    const path = `${versions}/${id}`;
    // Publication itself is tested with its own endpoint. Mark a version published for the editor reads.
    await db.update(timetableVersions).set({ status: 'published', publishedAt: new Date() }).where(and(
      eq(timetableVersions.id, BigInt(id)), eq(timetableVersions.tenantId, tenantId),
      eq(timetableVersions.academicYearId, BigInt(academicYearId)),
    ));
    expect((await agent.delete(path)).status).toBe(409);
    expect((await agent.patch(path).send({ name: 'Renamed' })).status).toBe(409);
    expect((await agent.post(`${path}/lock`).send({ blockId })).status).toBe(409);
    expect((await agent.post(`${base}/generate`).send({ versionId: id })).status).toBe(409);

    expect((await agent.patch(`/api/staff/${teacherIds[0]}`).send({ status: 'suspended' })).status).toBe(200);
    expect((await agent.patch(`${base}/bell`).send({ dayTypes: [{ ...result.body.data.bell.dayTypes[0], days: [1, 2] }] })).status).toBe(200);
    const detail = (await agent.get(path)).body.data;
    expect(detail.days).toEqual([1, 2, 3, 4, 5]);
    expect(detail.entries).toEqual(result.body.data.entries);
    expect(detail.requiresRegeneration).toBe(false);
    const availability = await agent.get(`${path}/teacher-availability`).query({ blockId });
    expect(availability.status, availability.body.message).toBe(200);
    const [teacher] = availability.body.data.teachers;
    expect(teacher).toEqual(expect.objectContaining({ id: teacherIds[0], name: 'Asha Kumar', planned: 2 }));
    expect(teacher.days).toHaveLength(5);
    for (const day of teacher.days) expect(day.periods).toHaveLength(8);
  });
});
