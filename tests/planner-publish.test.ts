import { and, eq, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { classrooms, staff, subjects, timeSlots, timetableEntries, timetableVersions } from '../src/db/schema';
import { todayInTimezone } from '../src/lib/dates';
import type { AuthedAgent } from './helpers';
import {
  addPlannerSection, combinedPlannerSample, createPlannerSchool, insertPlannerBellSlots, smallPlannerSample, teamTaughtPlannerSample,
} from './helpers/plannerSchool';

// Publishing copies a draft into timetable_entries inside one transaction, and restore flips the same rows back.
// The sample school: 7 teachers (maxima 35, loads 28/28/28/28/28/30/30), 5 sections, 8 periods a day, 200 class periods.

const base = '/api/timetable-planner';
const versions = `${base}/versions`;

type School = Awaited<ReturnType<typeof createPlannerSchool>>;

async function generate(agent: AuthedAgent, seed = 42, budgetMs = 200) {
  const response = await agent.post(`${base}/generate`).send({ seed, budgetMs });
  expect(response.status, response.body.message).toBe(201);
  expect(response.body.data.unplaced, 'the draft must be complete before it can be published').toEqual([]);
  return response.body.data.version.id as string;
}

const publish = (agent: AuthedAgent, id: string, body: object = {}) => agent.post(`${versions}/${id}/publish`).send(body);
const restore = (agent: AuthedAgent, id: string) => agent.post(`${versions}/${id}/restore`).send({});
const preview = (agent: AuthedAgent, id: string) => agent.get(`${versions}/${id}/publish-preview`);

const entries = (school: School, ...conditions: (SQL | undefined)[]) =>
  db.select().from(timetableEntries).where(and(eq(timetableEntries.tenantId, school.tenantId), ...conditions));
const active = eq(timetableEntries.status, 'active');
const byId = <T extends { id: bigint }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
const stripUpdated = <T extends { updatedAt: Date }>(rows: T[]) => byId(rows as (T & { id: bigint })[]).map(({ updatedAt: _updatedAt, ...rest }) => rest);

async function versionRow(id: string) {
  const [row] = await db.select().from(timetableVersions).where(eq(timetableVersions.id, BigInt(id)));
  return row;
}

const manualRow = (school: School, sectionId: string | bigint, slotId: bigint, day: number, over: Partial<typeof timetableEntries.$inferInsert> = {}) => ({
  tenantId: school.tenantId, academicYearId: BigInt(school.academicYearId), sectionId: BigInt(sectionId),
  subjectId: BigInt(school.subjectIds[0]), teacherId: null, source: 'manual', timeSlotId: slotId, dayOfWeek: day,
  effectiveFrom: '2026-06-01', status: 'active', ...over,
} satisfies typeof timetableEntries.$inferInsert);

/** Active manual lessons of the given section on every day and period of the sample bell. */
const fullWeek = (school: School, sectionId: string | bigint, slots: { id: bigint }[], over: Partial<typeof timetableEntries.$inferInsert>) =>
  [1, 2, 3, 4, 5].flatMap((day) => slots.map((slot) => manualRow(school, sectionId, slot.id, day, over)));

describe('publishing a timetable', () => {
  it('accepts just one of two competing drafts confirmed against the same published timetable', async () => {
    const { agent } = await createPlannerSchool('publish-concurrent-drafts', smallPlannerSample());
    const first = await generate(agent);
    const second = await generate(agent);
    const [firstPreview, secondPreview] = await Promise.all([preview(agent, first), preview(agent, second)]);
    expect([firstPreview.status, secondPreview.status]).toEqual([200, 200]);
    const results = await Promise.all([
      publish(agent, first, { revision: firstPreview.body.data.revision }),
      publish(agent, second, { revision: secondPreview.body.data.revision }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const statuses = await Promise.all([versionRow(first), versionRow(second)]);
    expect(statuses.map((version) => version.status).sort()).toEqual(['draft', 'published']);
  });
  it('requires a fresh preview when a previously previewed draft changes', async () => {
    const school = await createPlannerSchool('publish-stale-preview', smallPlannerSample());
    const { agent } = school;
    const id = await generate(agent);
    const first = await preview(agent, id);
    expect(first.status).toBe(200);
    const revision = first.body.data.revision as string;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await agent.patch(versions + '/' + id).send({ name: 'Revised draft' })).status).toBe(200);
    const refused = await publish(agent, id, { revision });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Refresh the publishing preview');
    expect(await entries(school)).toHaveLength(0);
    const fresh = await preview(agent, id);
    expect(fresh.body.data.revision).not.toBe(revision);
    expect((await publish(agent, id, { revision: fresh.body.data.revision })).status).toBe(201);
  });

  it('blocks publication when a complete saved draft still violates a Critical rule', async () => {
    const sample = smallPlannerSample();
    sample.rules.defaults = { ...sample.rules.defaults, teacherMaxPerDay: { value: 1, level: 'critical' } };
    const school = await createPlannerSchool('publish-critical', sample);
    const id = await generate(school.agent);
    const saved = await versionRow(id);
    const placements = saved.entries.map((entry, index) => ({ ...entry, day: 1, startNo: index + 1 }));
    await db.update(timetableVersions).set({ entries: placements }).where(eq(timetableVersions.id, saved.id));
    const checked = await preview(school.agent, id);
    expect(checked.status).toBe(200);
    expect(checked.body.data.unplaced).toBe(0);
    expect(checked.body.data.blockers).toEqual(expect.arrayContaining([expect.stringContaining('at most 1 periods per day')]));
    expect((await publish(school.agent, id, { revision: checked.body.data.revision })).status).toBe(409);
    expect(await entries(school)).toHaveLength(0);
  });
  it('preview counts 200 class entries and 5 classes', async () => {
    const school = await createPlannerSchool('publish-preview');
    const id = await generate(school.agent);
    const response = await preview(school.agent, id);
    expect(response.status, response.body.message).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      academicYearId: school.academicYearId, classEntries: 200, classes: 5, teacherEntries: 200, teachers: 7, periodRows: 8,
      plannerEntriesReplaced: 0, manualEntriesArchived: 0, blockers: [], unplaced: 0,
    }));
    expect([...response.body.data.sectionIds].sort()).toEqual([...school.sectionIds].sort());
    expect(await entries(school)).toHaveLength(0); // a preview writes nothing
  });

  it('publish writes 200 planner rows and archives the previous planner rows', async () => {
    const school = await createPlannerSchool('publish-write');
    const { agent, tenantId } = school;
    const first = await generate(agent);
    const published = await publish(agent, first, { effectiveFrom: '2026-06-01' });
    expect(published.status, published.body.message).toBe(201);
    expect(published.body.data).toEqual({ entries: 200 });

    const live = await entries(school, active);
    expect(live).toHaveLength(200);
    expect(live.every((row) => row.source === 'planner' && row.versionId === BigInt(first) && row.effectiveFrom === '2026-06-01'
      && row.archivedByVersionId === null && row.title === null && row.subjectId !== null)).toBe(true);
    expect(new Set(live.map((row) => row.teacherId)).size).toBe(7);
    const slots = await db.select().from(timeSlots).where(eq(timeSlots.tenantId, tenantId));
    expect(slots).toHaveLength(8);
    expect(slots.every((slot) => slot.dayType === 'usual' && slot.isActive && slot.days.join() === '1,2,3,4,5')).toBe(true);
    expect(await versionRow(first)).toEqual(expect.objectContaining({
      status: 'published', previousVersionId: null, publishedAt: expect.any(Date), publishedBy: expect.anything(),
    }));

    const second = await generate(agent, 7, 3000);
    expect((await preview(agent, second)).body.data).toEqual(expect.objectContaining({ plannerEntriesReplaced: 200, manualEntriesArchived: 0 }));
    const today = [todayInTimezone('Asia/Kolkata')];
    const replaced = await publish(agent, second);
    today.push(todayInTimezone('Asia/Kolkata'));
    expect(replaced.status, replaced.body.message).toBe(201);
    expect(replaced.body.data).toEqual({ entries: 200 });

    const now = await entries(school, active);
    expect(now).toHaveLength(200);
    expect(now.every((row) => row.versionId === BigInt(second) && today.includes(row.effectiveFrom))).toBe(true);
    const old = await entries(school, eq(timetableEntries.versionId, BigInt(first)));
    expect(old).toHaveLength(200);
    expect(old.every((row) => row.status === 'inactive' && row.archivedByVersionId === BigInt(second))).toBe(true);
    expect((await versionRow(first)).status).toBe('archived');
    expect(await versionRow(second)).toEqual(expect.objectContaining({ status: 'published', previousVersionId: BigInt(first) }));
    expect(await db.select().from(timeSlots).where(eq(timeSlots.tenantId, tenantId))).toHaveLength(8);

    const state = await agent.get(`${base}/state`);
    expect(state.body.data.versions.find((version: { id: string }) => version.id === second)).toEqual(
      expect.objectContaining({ status: 'published', canRestore: true }),
    );
    expect((await publish(agent, second)).status).toBe(409); // already published
  });

  it('publish archives manual rows in the published sections and restore reactivates them', async () => {
    const school = await createPlannerSchool('publish-manual');
    const { agent, sectionIds } = school;
    expect((await agent.patch(`${base}/sections/${sectionIds[4]}/excluded`).send({ excluded: true })).status).toBe(200);
    const slots = await insertPlannerBellSlots(school.tenantId);
    const manual = await db.insert(timetableEntries).values([
      manualRow(school, sectionIds[0], slots[0].id, 1), manualRow(school, sectionIds[0], slots[1].id, 1),
      manualRow(school, sectionIds[0], slots[0].id, 2),
      manualRow(school, sectionIds[4], slots[0].id, 1), // a class the plan leaves out stays as it is
    ]).returning();
    const [inPlan, outOfPlan] = [manual.filter((row) => row.sectionId === BigInt(sectionIds[0])), manual[3]];

    const id = await generate(agent);
    const dry = await preview(agent, id);
    expect(dry.body.data).toEqual(expect.objectContaining({ classEntries: 160, classes: 4, manualEntriesArchived: 3, plannerEntriesReplaced: 0 }));
    expect((await publish(agent, id)).status).toBe(201);

    const archived = await entries(school, eq(timetableEntries.source, 'manual'));
    expect(byId(archived).map((row) => [row.id, row.status, row.archivedByVersionId])).toEqual(byId(manual).map((row) => [
      row.id, row.id === outOfPlan.id ? 'active' : 'inactive', row.id === outOfPlan.id ? null : BigInt(id),
    ]));
    expect(await entries(school, active, eq(timetableEntries.source, 'planner'))).toHaveLength(160);

    const restored = await restore(agent, id);
    expect(restored.status, restored.body.message).toBe(200);
    expect(stripUpdated(await entries(school, eq(timetableEntries.source, 'manual')))).toEqual(stripUpdated(manual));
    expect(inPlan).toHaveLength(3);
    expect(await entries(school, active, eq(timetableEntries.source, 'planner'))).toHaveLength(0);
    expect((await versionRow(id)).status).toBe('archived');
  });

  it("restore returns the previous published version's rows exactly", async () => {
    const school = await createPlannerSchool('publish-restore');
    const { agent, tenantId } = school;
    const first = await generate(agent);
    expect((await publish(agent, first, { effectiveFrom: '2026-06-01' })).status).toBe(201);
    const original = stripUpdated(await entries(school, active));
    expect(original).toHaveLength(200);

    const second = await generate(agent, 7, 3000);
    expect((await publish(agent, second, { effectiveFrom: '2026-07-01' })).status).toBe(201);
    expect(await entries(school, active, eq(timetableEntries.versionId, BigInt(first)))).toHaveLength(0);

    const restored = await restore(agent, second);
    expect(restored.status, restored.body.message).toBe(200);
    expect(stripUpdated(await entries(school, active))).toEqual(original);
    const undone = await entries(school, eq(timetableEntries.versionId, BigInt(second)));
    expect(undone).toHaveLength(200);
    expect(undone.every((row) => row.status === 'inactive')).toBe(true);
    expect((await versionRow(first)).status).toBe('published');
    expect((await versionRow(second)).status).toBe('archived');
    expect(await db.select().from(timeSlots).where(eq(timeSlots.tenantId, tenantId))).toHaveLength(8);
    expect((await restore(agent, second)).status).toBe(409); // no longer the published timetable
  });

  it("publish is refused with a named conflict when another section's active entry holds the teacher", async () => {
    const school = await createPlannerSchool('publish-conflict');
    const { agent, sectionIds, teacherIds } = school;
    expect((await agent.patch(`${base}/sections/${sectionIds[4]}/excluded`).send({ excluded: true })).status).toBe(200);
    const slots = await insertPlannerBellSlots(school.tenantId);
    // the teacher is busy in section E in every period of the week
    const kept = await db.insert(timetableEntries).values(fullWeek(school, sectionIds[4], slots, { teacherId: BigInt(teacherIds[0]) })).returning();
    const id = await generate(agent);
    const asha = (await agent.get(`${versions}/${id}`)).body.data.entries
      .filter((entry: { teacherIds: string[] }) => entry.teacherIds.includes(teacherIds[0])).length;
    expect(asha).toBeGreaterThan(0);

    const dry = await preview(agent, id);
    expect(dry.body.data.blockers).toHaveLength(asha);
    const refused = await publish(agent, id);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Asha Kumar is already booked in Grade 5 E');
    expect(refused.body.errors).toHaveLength(asha); // every clash is listed, not only the first

    expect(await entries(school, eq(timetableEntries.source, 'planner'))).toHaveLength(0);
    expect(await entries(school, active)).toHaveLength(kept.length);
    expect((await versionRow(id)).status).toBe('draft');
  });

  it('a room used only through classroomIds blocks publish when another section holds it', async () => {
    const school = await createPlannerSchool('publish-room', smallPlannerSample());
    const { agent, tenantId, classId } = school;
    const [room] = await db.insert(classrooms).values({ tenantId, code: 'LAB1', name: 'Lab 1' }).returning();
    const other = await addPlannerSection(tenantId, classId, 'G');
    const lesson = (await agent.get(`${base}/state`)).body.data.lessons[0];
    const edit = await agent.patch(`${base}/lessons/${lesson.id}`).send({
      ...lesson, parts: [{ ...lesson.parts[0], room: { type: 'fixed', roomIds: [room.id.toString()] } }],
    });
    expect(edit.status, edit.body.message).toBe(200);
    const slots = await insertPlannerBellSlots(tenantId);
    // section G holds the lab in every period, through classroom_ids only (classroom_id stays empty)
    await db.insert(timetableEntries).values(fullWeek(school, other, slots, { classroomIds: [room.id] }));

    const id = await generate(agent);
    const refused = await publish(agent, id);
    expect(refused.status, refused.body.message).toBe(409);
    expect(refused.body.message).toContain('Lab 1 is already booked in Grade 5 G');
    expect(await entries(school, eq(timetableEntries.source, 'planner'))).toHaveLength(0);
  });

  it('a team-taught lesson writes one row per teacher and the class list collapses them to one card', async () => {
    const school = await createPlannerSchool('publish-team', teamTaughtPlannerSample());
    const { agent, sectionIds, teacherIds } = school;
    const id = await generate(agent);
    const dry = await preview(agent, id);
    expect(dry.body.data).toEqual(expect.objectContaining({ classEntries: 1, teacherEntries: 2, teachers: 2, blockers: [] }));
    const published = await publish(agent, id);
    expect(published.status, published.body.message).toBe(201);
    expect(published.body.data).toEqual({ entries: 2 });

    const list = await agent.get('/api/timetable').query({ sectionId: sectionIds[0], status: 'active' });
    expect(list.status, list.body.message).toBe(200);
    expect(list.body.data).toHaveLength(2);
    const [a, b] = list.body.data;
    expect(a.timeSlotId).toBe(b.timeSlotId);
    expect(a.dayOfWeek).toBe(b.dayOfWeek);
    expect([a.teacherId, b.teacherId].sort()).toEqual([...teacherIds].sort());
    expect(a.subjectName).toBe('English');
  });

  it('two simultaneous publishes: one 201, one 409', async () => {
    const school = await createPlannerSchool('publish-race', smallPlannerSample());
    const id = await generate(school.agent);
    const results = await Promise.all([publish(school.agent, id), publish(school.agent, id)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)!.body.message).toContain('already published');
    expect(await entries(school, active)).toHaveLength(2);
    expect(await entries(school)).toHaveLength(2);
  });

  it('publishing after the bell changed is refused (requiresRegeneration)', async () => {
    const school = await createPlannerSchool('publish-stale-bell', smallPlannerSample());
    const { agent } = school;
    const id = await generate(agent);
    const bell = (await agent.get(`${base}/state`)).body.data.bell;
    expect((await agent.patch(`${base}/bell`).send({ dayTypes: [{ ...bell.dayTypes[0], days: [1, 2, 3, 4] }] })).status).toBe(200);
    expect((await agent.get(`${versions}/${id}`)).body.data.requiresRegeneration).toBe(true);

    expect((await preview(agent, id)).body.data.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('changed after this timetable was generated')]),
    );
    const refused = await publish(agent, id);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('changed after this timetable was generated');
    expect(await entries(school)).toHaveLength(0);
    expect(await db.select().from(timeSlots).where(eq(timeSlots.tenantId, school.tenantId))).toHaveLength(0);
  });

  it('publish never deletes a slot used by an entry', async () => {
    const school = await createPlannerSchool('publish-slots', smallPlannerSample());
    const { agent, tenantId, sectionIds, classId } = school;
    const other = await addPlannerSection(tenantId, classId, 'G');
    const saturday = (name: string, sequence: number, startsAt: string, endsAt: string) =>
      ({ tenantId, name, dayType: 'saturday', days: [6], sequence, startsAt, endsAt });
    const [used, old, unused] = await db.insert(timeSlots).values([
      saturday('Saturday A', 1, '09:00:00', '09:40:00'), saturday('Saturday B', 2, '09:40:00', '10:20:00'),
      saturday('Saturday C', 3, '10:20:00', '11:00:00'),
    ]).returning();
    await db.insert(timetableEntries).values([
      manualRow(school, other, used.id, 6), // another class still runs in this period: it must stay as it is
      manualRow(school, sectionIds[0], old.id, 6), // this class's own lesson is archived by the publication
    ]);

    const id = await generate(agent);
    expect((await publish(agent, id)).status).toBe(201);
    const slot = async (slotId: bigint) => (await db.select().from(timeSlots).where(eq(timeSlots.id, slotId)))[0];
    expect(await slot(used.id)).toEqual(expect.objectContaining({ isActive: true }));
    expect(await slot(old.id)).toEqual(expect.objectContaining({ isActive: false })); // only an old lesson uses it: switched off, not deleted
    expect(await slot(unused.id)).toBeUndefined(); // nothing uses it: gone
    const usual = await db.select().from(timeSlots).where(and(eq(timeSlots.tenantId, tenantId), eq(timeSlots.dayType, 'usual')));
    expect(usual).toHaveLength(8);
    const used8 = new Set((await entries(school, eq(timetableEntries.source, 'planner'))).map((row) => row.timeSlotId));
    expect(used8.size).toBeGreaterThan(0);
    expect(usual.map((row) => row.id)).toEqual(expect.arrayContaining([...used8]));

    expect((await restore(agent, id)).status).toBe(200);
    expect(await slot(used.id)).toEqual(expect.objectContaining({ isActive: true }));
    expect(await slot(old.id)).toEqual(expect.objectContaining({ isActive: true }));
    expect(await slot(unused.id)).toEqual(expect.objectContaining({ name: 'Saturday C', startsAt: '10:20:00', isActive: true }));
    const left = await db.select().from(timeSlots).where(and(eq(timeSlots.tenantId, tenantId), eq(timeSlots.dayType, 'usual')));
    expect(left.every((row) => !row.isActive)).toBe(true); // the version's own rows still use them, so they are switched off
    expect(left.length).toBeLessThanOrEqual(used8.size);
  });

  it('publish refuses a version whose teacher was deactivated', async () => {
    const school = await createPlannerSchool('publish-inactive-teacher', smallPlannerSample());
    const { agent, teacherIds } = school;
    const id = await generate(agent);
    expect((await agent.patch(`/api/staff/${teacherIds[0]}`).send({ status: 'suspended' })).status).toBe(200);

    expect((await preview(agent, id)).body.data.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('Teacher "Asha Kumar" is no longer an active teacher'),
    ]));
    const refused = await publish(agent, id);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Asha Kumar');
    expect(await entries(school)).toHaveLength(0);
    expect((await versionRow(id)).status).toBe('draft');
  });

  it('a teacher with no weekly maximum can publish', async () => {
    const school = await createPlannerSchool('publish-null-max', smallPlannerSample());
    await db.update(staff).set({ maxPeriodsPerWeek: null }).where(eq(staff.id, BigInt(school.teacherIds[0])));
    const id = await generate(school.agent);
    const published = await publish(school.agent, id);
    expect(published.status, published.body.message).toBe(201);
    expect(published.body.data).toEqual({ entries: 2 });
  });

  it('publish succeeds for a lesson combined across two classes', async () => {
    const school = await createPlannerSchool('publish-combined', combinedPlannerSample());
    const { agent, sectionIds, teacherIds } = school;
    const id = await generate(agent);
    const dry = await preview(agent, id);
    expect(dry.body.data).toEqual(expect.objectContaining({ classEntries: 2, teacherEntries: 2, teachers: 1, blockers: [] }));
    const published = await publish(agent, id);
    expect(published.status, published.body.message).toBe(201);
    expect(published.body.data).toEqual({ entries: 2 });

    // one teacher in one period for two classes: two active rows, one per class
    const live = await entries(school, active);
    expect(live).toHaveLength(2);
    expect(live.map((row) => row.sectionId.toString()).sort()).toEqual([...sectionIds].sort());
    expect(new Set(live.map((row) => row.teacherId)).size).toBe(1);
    expect(live[0].teacherId).toBe(BigInt(teacherIds[0]));
    expect(live[0].timeSlotId).toBe(live[1].timeSlotId);
    expect(live[0].dayOfWeek).toBe(live[1].dayOfWeek);
  });

  it('publish is refused with the class names when another class still uses a slot the new bell would change', async () => {
    const school = await createPlannerSchool('publish-slot-guard', smallPlannerSample());
    const { agent, tenantId, classId } = school;
    const other = await addPlannerSection(tenantId, classId, 'G');
    const slots = await insertPlannerBellSlots(tenantId);
    // an older bell: period 1 ran 08:30-09:10, and class G still has a lesson in it
    await db.update(timeSlots).set({ startsAt: '08:30:00', endsAt: '09:10:00' }).where(eq(timeSlots.id, slots[0].id));
    const [lesson] = await db.insert(timetableEntries).values(manualRow(school, other, slots[0].id, 1)).returning();

    const id = await generate(agent);
    const message = 'Slot Period 1 (usual #1) is used by Grade 5 G and would change from 08:30-09:10 to 09:00-09:40; move or clear those lessons first.';
    expect((await preview(agent, id)).body.data.blockers).toEqual(expect.arrayContaining([message]));
    const refused = await publish(agent, id);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain(message);
    expect(await entries(school, eq(timetableEntries.source, 'planner'))).toHaveLength(0);
    expect((await db.select().from(timeSlots).where(eq(timeSlots.id, slots[0].id)))[0].startsAt).toBe('08:30:00');

    // once the other class's lesson is cleared the period may move
    await db.update(timetableEntries).set({ status: 'inactive' }).where(eq(timetableEntries.id, lesson.id));
    expect((await publish(agent, id)).status).toBe(201);
    expect((await db.select().from(timeSlots).where(eq(timeSlots.id, slots[0].id)))[0].startsAt).toBe('09:00:00');
  });

  it('protects changed and overlapping slots used by another year during publish and restore', async () => {
    const school = await createPlannerSchool('publish-other-year-slots', smallPlannerSample());
    const { agent, tenantId, sectionIds } = school;
    const year = await agent.post('/api/academic-years').send({
      name: '2050-51', startsOn: '2050-06-01', endsOn: '2051-05-31',
    });
    expect(year.status, year.body.message).toBe(201);
    const otherYear = { academicYearId: BigInt(year.body.data.id), effectiveFrom: '2050-06-01' };
    const otherYearScope = eq(timetableEntries.academicYearId, otherYear.academicYearId);
    const [periodOne] = await insertPlannerBellSlots(tenantId);
    await db.update(timeSlots).set({ startsAt: '08:30:00', endsAt: '09:10:00' }).where(eq(timeSlots.id, periodOne.id));
    const [workshop] = await db.insert(timeSlots).values({
      tenantId, name: 'Workshop', dayType: 'legacy', sequence: 1, days: [1], startsAt: '09:10:00', endsAt: '09:25:00',
    }).returning();

    // Even rows for a section included in the draft are protected when they belong to a different year.
    await db.insert(timetableEntries).values([
      manualRow(school, sectionIds[0], periodOne.id, 1, otherYear),
      manualRow(school, sectionIds[0], workshop.id, 1, otherYear),
    ]);
    const schoolSlots = async () => byId(await db.select().from(timeSlots).where(eq(timeSlots.tenantId, tenantId)));
    const slotsBeforePublish = await schoolSlots();
    const rowsBeforePublish = byId(await entries(school));
    const id = await generate(agent);
    const changed = 'Slot Period 1 (usual #1) is used by Grade 5 A (2050-51) and would change from 08:30-09:10 to 09:00-09:40';
    const overlap = 'Slot Workshop (legacy #1) is used by Grade 5 A (2050-51) and would overlap Period 1 (usual #1, 09:00-09:40) on Mon';
    const dry = await preview(agent, id);
    expect(dry.status, dry.body.message).toBe(200);
    expect(dry.body.data.blockers).toEqual(expect.arrayContaining([expect.stringContaining(changed), expect.stringContaining(overlap)]));
    const refusedPublish = await publish(agent, id);
    expect(refusedPublish.status).toBe(409);
    expect(refusedPublish.body.message).toContain(changed);
    expect(refusedPublish.body.message).toContain(overlap);
    expect((await versionRow(id)).status).toBe('draft');
    expect(await schoolSlots()).toEqual(slotsBeforePublish);
    expect(byId(await entries(school))).toEqual(rowsBeforePublish);

    const releaseOtherYear = () => db.update(timetableEntries).set({ status: 'inactive' })
      .where(and(eq(timetableEntries.tenantId, tenantId), otherYearScope));
    await releaseOtherYear();
    const published = await publish(agent, id);
    expect(published.status, published.body.message).toBe(201);
    const [earlyWorkshop] = await db.insert(timeSlots).values({
      tenantId, name: 'Early workshop', dayType: 'legacy', sequence: 2, days: [1], startsAt: '08:40:00', endsAt: '08:50:00',
    }).returning();
    await db.insert(timetableEntries).values([
      manualRow(school, sectionIds[0], periodOne.id, 1, otherYear),
      manualRow(school, sectionIds[0], earlyWorkshop.id, 1, otherYear),
    ]);

    const slotsBeforeRestore = await schoolSlots();
    const rowsBeforeRestore = byId(await entries(school));
    const refusedRestore = await restore(agent, id);
    expect(refusedRestore.status).toBe(409);
    expect(refusedRestore.body.message).toContain('Slot Period 1 (usual #1) is used by Grade 5 A (2050-51) and would change from 09:00-09:40 to 08:30-09:10');
    expect(refusedRestore.body.message).toContain('Slot Early workshop (legacy #2) is used by Grade 5 A (2050-51) and would overlap Period 1 (usual #1, 08:30-09:10) on Mon');
    expect((await versionRow(id)).status).toBe('published');
    expect(await schoolSlots()).toEqual(slotsBeforeRestore);
    expect(byId(await entries(school))).toEqual(rowsBeforeRestore);

    await releaseOtherYear();
    const restored = await restore(agent, id);
    expect(restored.status, restored.body.message).toBe(200);
    expect((await schoolSlots()).find((slot) => slot.id === periodOne.id)?.startsAt).toBe('08:30:00');
    expect(await entries(school, active)).toHaveLength(0);
  });

  it('restore returns 409 when a reactivated row clashes', async () => {
    const school = await createPlannerSchool('publish-restore-clash');
    const { agent } = school;
    const first = await generate(agent);
    expect((await publish(agent, first, { effectiveFrom: '2026-06-01' })).status).toBe(201);
    const [held] = await entries(school, active);
    const second = await generate(agent, 7, 3000);
    expect((await publish(agent, second, { effectiveFrom: '2026-07-01' })).status).toBe(201);
    // after the second publication a lesson is added by hand to a class in the first one's period
    await db.insert(timetableEntries).values(manualRow(school, held.sectionId, held.timeSlotId, held.dayOfWeek, { classroomId: null }));

    const refused = await restore(agent, second);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('cannot be restored');
    expect(refused.body.message).toContain('already has another lesson');
    // nothing changed
    expect((await versionRow(second)).status).toBe('published');
    expect((await versionRow(first)).status).toBe('archived');
    expect(await entries(school, active, eq(timetableEntries.versionId, BigInt(second)))).toHaveLength(200);
    expect(await entries(school, active, eq(timetableEntries.versionId, BigInt(first)))).toHaveLength(0);
  });

  it('publish refuses a version whose subject was removed', async () => {
    const school = await createPlannerSchool('publish-removed-subject', smallPlannerSample());
    const { agent, subjectIds } = school;
    const id = await generate(agent);
    await db.update(subjects).set({ deletedAt: new Date() }).where(eq(subjects.id, BigInt(subjectIds[0])));

    expect((await preview(agent, id)).body.data.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('Subject "English" no longer exists'),
    ]));
    const refused = await publish(agent, id);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Subject "English" no longer exists');
    expect(await entries(school)).toHaveLength(0);
    expect((await versionRow(id)).status).toBe('draft');
  });
});
