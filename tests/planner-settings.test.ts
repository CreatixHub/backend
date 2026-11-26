import { and, eq } from 'drizzle-orm';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { classrooms, plannerSettings } from '../src/db/schema';
import { currentAcademicYearId, signupAndLogin, uniqueSlug, type AuthedAgent } from './helpers';

const base = '/api/timetable-planner';

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const school = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(school.status).toBe(201);
  expect((await switchOrganization(slug)).status).toBe(200);
  return { agent, tenantId: BigInt(school.body.data.id as string) };
}

function responseId(response: Response): string {
  expect(response.status, response.body.message).toBe(201);
  expect(response.body.data.id).toMatch(/^\d+$/);
  return response.body.data.id as string;
}

async function makeSections(agent: AuthedAgent, names: string[]) {
  const classId = responseId(await agent.post('/api/classes').send({ gradeLevel: 5, name: 'Grade 5', code: 'G5' }));
  const ids: string[] = [];
  for (const name of names) {
    ids.push(responseId(await agent.post('/api/sections').send({ classId, name, capacity: 30 })));
  }
  return ids;
}

async function makeSubject(agent: AuthedAgent, code: string, name: string) {
  return responseId(await agent.post('/api/subjects').send({ code, name, subjectType: 'core' }));
}

async function makeTeacher(agent: AuthedAgent, fields?: Record<string, unknown>) {
  return responseId(await agent.post('/api/staff').send({
    firstName: 'Asha', lastName: 'Kumar', staffType: 'teaching', employmentType: 'full_time',
    joinedOn: '2026-06-01', createLogin: false, ...fields,
  }));
}

const period = (id: string, startsAt: string, endsAt: string) => ({ id, startsAt, endsAt, isBreak: false });
const usual = {
  id: 'usual', name: 'Usual day', days: [1, 2, 3, 4, 5], periods: [period('p1', '09:00', '09:40')],
};
const bell = { weekType: 'weekly', dayTypes: [usual] };
const lesson = (sectionId: string, subjectId: string | null, teacherId: string, count = 2) => ({
  sectionIds: [sectionId], subjectId,
  parts: [{ id: 'main', pattern: [{ count, length: 1 }], teacherIds: [teacherId] }],
});

async function readRevision(tenantId: bigint, academicYearId: string) {
  const [row] = await db.select({ revision: plannerSettings.revision }).from(plannerSettings)
    .where(and(eq(plannerSettings.tenantId, tenantId), eq(plannerSettings.academicYearId, BigInt(academicYearId))));
  return row.revision;
}

describe('timetable planner settings and lessons', () => {
  it('returns lookups with active staff profiles, planned periods and the defaults at revision zero', async () => {
    const { agent } = await setupSchool('planner-lookups');
    const [sectionId] = await makeSections(agent, ['A']);
    const subjectId = await makeSubject(agent, 'MATH', 'Mathematics');
    const otherSubjectId = await makeSubject(agent, 'SCI', 'Science');
    const teacherId = await makeTeacher(agent, {
      primarySubjectId: subjectId, additionalSubjectIds: [otherSubjectId], maxPeriodsPerWeek: 15,
    });
    await makeTeacher(agent, { firstName: 'Support', staffType: 'non_teaching' });
    for (const _ of [1, 2]) {
      const initial = await agent.get(`${base}/state`);
      expect(initial.status).toBe(200);
      expect(initial.body.data.revision).toBe(0);
      expect(initial.body.data.bell.dayTypes[0].id).toBe('usual');
      expect(initial.body.data.lookups.staff[0].plannedPeriods).toBe(0);
    }

    responseId(await agent.post(`${base}/lessons`).send(lesson(sectionId, subjectId, teacherId)));
    const state = (await agent.get(`${base}/state`)).body.data;
    expect(state.lookups.staff).toEqual([{
      id: teacherId, name: 'Asha Kumar', staffType: 'teaching', primarySubjectId: subjectId,
      subjectIds: [subjectId, otherSubjectId], maxPeriodsPerWeek: 15, plannedPeriods: 2,
    }]);
    expect(state.lookups.sections).toEqual([expect.objectContaining({ id: sectionId, className: 'Grade 5', excluded: false })]);
    expect(state.lookups.subjects.map((subject: { id: string }) => subject.id)).toEqual([subjectId, otherSubjectId]);
    expect(state.lookups.defaultRules.teacherLongDays).toEqual({ value: 2, level: 'high' });
  });

  it('reports an overlapping bell row and a day in two day types', async () => {
    const { agent } = await setupSchool('planner-bell');
    const overlapping = await agent.patch(`${base}/bell`).send({
      dayTypes: [{ ...usual, periods: [...usual.periods, period('p2', '09:30', '10:15')] }],
    });
    expect(overlapping.status).toBe(400);
    expect(overlapping.body.message).toBe('"Usual day", row 2: overlaps the row above.');
    const overlappingDay = await agent.patch(`${base}/bell`).send({
      dayTypes: [usual, { ...usual, id: 'fri', name: 'Friday', days: [5] }],
    });
    expect(overlappingDay.status).toBe(400);
    expect(overlappingDay.body.message).toBe('Friday is in more than one day type.');

    const invalidRule = await agent.patch(`${base}/rules`).send({ defaults: { teacherLongDays: { value: 21, level: 'high' } } });
    expect(invalidRule.status).toBe(400);
    expect(invalidRule.body.message).toBe('Rules: "teacherLongDays" needs a whole number between 1 and 20.');
    expect((await agent.get(`${base}/state`)).body.data.revision).toBe(0);
  });

  it('requires a subject or activity and rejects a teacher and an academic year from another school', async () => {
    const local = await setupSchool('planner-local');
    const remote = await setupSchool('planner-remote');
    const remoteYear = await currentAcademicYearId(remote.agent);
    const [sectionId] = await makeSections(local.agent, ['A']);
    const subjectId = await makeSubject(local.agent, 'MATH', 'Mathematics');
    const teacherId = await makeTeacher(remote.agent);

    const missingTitle = await local.agent.post(`${base}/lessons`).send(lesson(sectionId, null, teacherId));
    expect(missingTitle.status).toBe(400);
    expect(missingTitle.body.message).toBe('Choose a subject, or name the activity (for example "Library").');
    const foreignTeacher = await local.agent.post(`${base}/lessons`).send(lesson(sectionId, subjectId, teacherId));
    expect(foreignTeacher.status).toBe(400);
    expect(foreignTeacher.body.message).toBe('One of the chosen teachers no longer exists.');
    const foreignYear = await local.agent.get(`${base}/readiness?academicYearId=${remoteYear}`);
    expect(foreignYear.status).toBe(404);
    const invalidId = await local.agent.get(`${base}/state?academicYearId=invalid`);
    expect(invalidId.status).toBe(400);
    const state = (await local.agent.get(`${base}/state`)).body.data;
    expect(state.revision).toBe(0);
    expect(state.lessons).toEqual([]);
  });

  it('bumps the affected revisions once per committed write and preserves the other year’s lessons', async () => {
    const { agent, tenantId } = await setupSchool('planner-revisions');
    const yearId = await currentAcademicYearId(agent);
    const otherYear = responseId(await agent.post('/api/academic-years').send({
      name: '2050-51', startsOn: '2050-06-01', endsOn: '2051-05-31',
    }));
    const otherYearQuery = `?academicYearId=${otherYear}`;
    const [sectionId, targetId] = await makeSections(agent, ['A', 'B']);
    const subjectId = await makeSubject(agent, 'MATH', 'Mathematics');
    const teacherId = await makeTeacher(agent);
    // Existing classrooms are the planner's room catalogue. There is no classroom-create planner route.
    const [room] = await db.insert(classrooms).values({
      tenantId, code: 'LAB', name: 'Lab', capacity: 35, roomType: 'lab',
    }).returning({ id: classrooms.id });
    const roomPath = `${base}/rooms/${room.id}`;
    expect((await agent.get(`${base}/state`)).body.data.revision).toBe(0);
    expect((await agent.get(`${base}/state${otherYearQuery}`)).body.data.revision).toBe(0);

    let revision = 0;
    let otherRevision = 0;
    async function check(response: Response, status: number, currentChange: number, otherChange = 0) {
      expect(response.status, response.body.message).toBe(status);
      revision += currentChange;
      otherRevision += otherChange;
      expect(await readRevision(tenantId, yearId)).toBe(revision);
      expect(await readRevision(tenantId, otherYear)).toBe(otherRevision);
    }

    await check(await agent.patch(`${base}/bell`).send(bell), 200, 1);
    await check(await agent.patch(`${base}/rules`).send({ defaults: { teacherLongDays: { value: 20, level: 'high' } } }), 200, 1);
    const availability = await agent.patch(`${base}/availability/staff/${teacherId}`).send({
      blocked: [{ day: 2, period: 1 }, { day: 1, period: 1 }, { day: 2, period: 1 }, { day: 8, period: 1 }],
    });
    await check(availability, 200, 1);
    expect(availability.body.data.blocked).toEqual([{ day: 1, period: 1 }, { day: 2, period: 1 }]);
    await check(await agent.patch(`${base}/sections/${sectionId}/excluded`).send({ excluded: true }), 200, 1);

    const group = await agent.post(`${base}/room-groups`).send({ name: 'Science Labs' });
    await check(group, 201, 1);
    const groupId = responseId(group);
    await check(await agent.post(`${base}/room-groups`).send({ name: 'science labs' }), 409, 0);
    await check(await agent.patch(roomPath).send({ groupId }), 200, 1, 1);
    await check(await agent.patch(roomPath).send({ groupId }), 200, 0);
    await check(await agent.patch(roomPath).send({ groupId, name: 'Another lab' }), 400, 0);

    const payload = lesson(sectionId, subjectId, teacherId);
    const made = await agent.post(`${base}/lessons`).send(payload);
    await check(made, 201, 1);
    const id = responseId(made);
    const updated = await agent.patch(`${base}/lessons/${id}`).send({ ...payload, syncGroup: 'parallel' });
    await check(updated, 200, 1);
    const copied = await agent.post(`${base}/lessons/${id}/copy`).send({ sectionIds: [targetId, targetId] });
    await check(copied, 201, 1);
    expect(copied.body.data).toHaveLength(1);
    expect(copied.body.data[0]).toEqual(expect.objectContaining({ sectionIds: [targetId], syncGroup: `parallel-${targetId}` }));
    expect(copied.body.data[0].parts[0].id).not.toBe(updated.body.data.parts[0].id);
    await check(await agent.delete(`${base}/lessons/${id}${otherYearQuery}`), 404, 0);
    await check(await agent.delete(`${base}/lessons/${id}`), 204, 1);

    const withGroup = await agent.post(`${base}/lessons${otherYearQuery}`).send({
      ...payload,
      parts: [{ ...payload.parts[0], room: { type: 'oneOf', groupId } }],
    });
    await check(withGroup, 201, 0, 1);
    const blocked = await agent.delete(`${base}/room-groups/${groupId}`);
    await check(blocked, 409, 0);
    expect(blocked.body.message).toContain('used by a lesson');
    const otherState = (await agent.get(`${base}/state${otherYearQuery}`)).body.data;
    expect(otherState.lessons.map((row: { id: string }) => row.id)).toEqual([responseId(withGroup)]);
    expect(otherState.lookups.sections[0].excluded).toBe(false);
    await check(await agent.delete(`${base}/lessons/${responseId(withGroup)}${otherYearQuery}`), 204, 0, 1);
    await check(await agent.delete(`${base}/room-groups/${groupId}`), 204, 1, 1);
    expect((await agent.get(`${base}/state`)).body.data.rooms[0].groupId).toBeNull();
  });

  it('blocks a teacher above their weekly maximum and warns when the subject is short', async () => {
    const { agent } = await setupSchool('planner-capacity');
    const [sectionId] = await makeSections(agent, ['A']);
    const subjectId = await makeSubject(agent, 'MATH', 'Mathematics');
    const teacherId = await makeTeacher(agent, { primarySubjectId: subjectId, maxPeriodsPerWeek: 1 });
    expect((await agent.patch(`${base}/bell`).send(bell)).status).toBe(200);
    responseId(await agent.post(`${base}/lessons`).send(lesson(sectionId, subjectId, teacherId)));
    const check = await agent.get(`${base}/readiness`);
    expect(check.status).toBe(200);
    expect(check.body.data.ok).toBe(false);
    expect(check.body.data.blocking).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'teacher_max', teacherId })]));
    expect(check.body.data.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'subject_shortage', subjectId })]));
  });

  it('keeps the lesson and reports blockers when its teacher is deactivated or its subject is removed', async () => {
    const { agent } = await setupSchool('planner-inactive');
    const [sectionId] = await makeSections(agent, ['A']);
    const subjectId = await makeSubject(agent, 'MATH', 'Mathematics');
    const teacherId = await makeTeacher(agent, { primarySubjectId: subjectId });
    expect((await agent.patch(`${base}/bell`).send(bell)).status).toBe(200);
    const lessonId = responseId(await agent.post(`${base}/lessons`).send(lesson(sectionId, subjectId, teacherId)));
    expect((await agent.patch(`/api/staff/${teacherId}`).send({ status: 'suspended' })).status).toBe(200);
    const blocked = (await agent.get(`${base}/readiness`)).body.data;
    expect(blocked.ok).toBe(false);
    expect(blocked.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bad_teacher', teacherId, message: expect.stringContaining('Asha Kumar') }),
    ]));

    expect((await agent.delete(`/api/subjects/${subjectId}`)).status).toBe(204);
    const afterRemoval = (await agent.get(`${base}/readiness`)).body.data;
    expect(afterRemoval.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bad_subject', subjectId }),
    ]));
    const state = (await agent.get(`${base}/state`)).body.data;
    expect(state.lookups.staff).toEqual([]);
    expect(state.lookups.subjects).toEqual([]);
    expect(state.lessons).toEqual([expect.objectContaining({ id: lessonId, subjectId })]);
  });
});
