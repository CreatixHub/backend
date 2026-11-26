import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { classrooms } from '../src/db/schema';
import { signupAndLogin, uniqueSlug, type AuthedAgent } from './helpers';
import { createPlannerSchool, smallPlannerSample } from './helpers/plannerSchool';

const base = '/api/timetable-planner';
const versions = `${base}/versions`;

function expectStatus(response: Response, status: number) {
  expect(response.status, `${response.request.method} ${response.request.url}: ${response.body.message ?? ''}`).toBe(status);
}

async function expectVersionsHidden(
  agent: AuthedAgent, academicYearId: string, draftId: string, publishedId: string, blockId: string,
) {
  const draft = `${versions}/${draftId}`;
  const published = `${versions}/${publishedId}`;
  const year = { academicYearId };
  const block = { blockId };
  const position = { ...block, day: 1, startNo: 1 };
  const requests = [
    () => agent.get(draft).query(year),
    () => agent.get(published).query(year),
    () => agent.patch(draft).query(year).send({ name: 'Unauthorized rename' }),
    () => agent.delete(draft).query(year),
    () => agent.post(`${draft}/duplicate`).query(year).send({}),
    () => agent.get(`${draft}/reports`).query(year),
    () => agent.get(`${draft}/fit`).query({ ...year, ...block }),
    () => agent.get(`${draft}/teacher-availability`).query({ ...year, ...block }),
    () => agent.post(`${draft}/check-move`).query(year).send(position),
    () => agent.post(`${draft}/move`).query(year).send(position),
    () => agent.post(`${draft}/place`).query(year).send(position),
    () => agent.post(`${draft}/unschedule`).query(year).send(block),
    () => agent.post(`${draft}/lock`).query(year).send({ ...block, locked: true }),
    () => agent.post(`${base}/generate`).query(year).send({ versionId: draftId, seed: 42, budgetMs: 200 }),
    () => agent.get(`${draft}/publish-preview`).query(year),
    () => agent.post(`${draft}/publish`).query(year).send({}),
    () => agent.post(`${published}/restore`).query(year).send({}),
  ];
  for (const request of requests) expectStatus(await request(), 404);
}

describe('timetable planner isolation', () => {
  it('keeps planner versions, lesson settings and published periods in their school and year', async () => {
    const school = await createPlannerSchool('planner-isolation-a', smallPlannerSample());
    const { agent, academicYearId, lessonIds, sectionIds, teacherIds, subjectIds } = school;
    const { agent: other, switchOrganization } = await signupAndLogin('planner-isolation-b');
    const slug = uniqueSlug('planner-isolation-b');
    const organization = await other.post('/api/organizations').send({ name: 'Other planner school', slug });
    expectStatus(organization, 201);
    expectStatus(await switchOrganization(slug), 200);
    const otherYear = await other.get('/api/academic-years/current');
    expectStatus(otherYear, 200);
    const otherSchoolYearId = otherYear.body.data.id as string;

    const year = await agent.post('/api/academic-years').send({
      name: '2050-51', startsOn: '2050-06-01', endsOn: '2051-05-31',
    });
    expectStatus(year, 201);
    const secondYearId = year.body.data.id as string;

    const [room, otherRoom] = await db.insert(classrooms).values([
      { tenantId: school.tenantId, code: 'LAB', name: 'Published school lab' },
      { tenantId: BigInt(organization.body.data.id), code: 'LAB', name: 'Other school lab' },
    ]).returning({ id: classrooms.id });
    const roomGroup = await agent.post(`${base}/room-groups`).send({ name: 'Published school labs' });
    expectStatus(roomGroup, 201);
    const groupId = roomGroup.body.data.id as string;
    expectStatus(await agent.patch(`${base}/rooms/${room.id}`).send({ groupId }), 200);

    const generated = await agent.post(`${base}/generate`).send({ seed: 42, budgetMs: 200 });
    expectStatus(generated, 201);
    expect(generated.body.data.unplaced).toEqual([]);
    const publishedId = generated.body.data.version.id as string;
    const blockId = generated.body.data.entries[0].blockId as string;
    const duplicate = await agent.post(`${versions}/${publishedId}/duplicate`).send({});
    expectStatus(duplicate, 201);
    const draftId = duplicate.body.data.version.id as string;
    const published = await agent.post(`${versions}/${publishedId}/publish`).send({ effectiveFrom: '2026-06-01' });
    expectStatus(published, 201);
    expect(published.body.data).toEqual({ entries: 2 });

    const classFilter = { sectionId: sectionIds[0], status: 'active' };
    const teacherFilter = { teacherId: teacherIds[0], status: 'active' };
    for (const [filter, expected] of [[classFilter, 1], [teacherFilter, 2]] as const) {
      const owned = await agent.get('/api/timetable').query({ ...filter, academicYearId });
      expectStatus(owned, 200);
      expect(owned.body.data).toHaveLength(expected);
      expect(owned.body.data).toEqual(Array.from({ length: expected }, () => expect.objectContaining({
        academicYearId, teacherId: teacherIds[0], source: 'planner',
      })));
      const wrongYear = await agent.get('/api/timetable').query({ ...filter, academicYearId: secondYearId });
      expectStatus(wrongYear, 200);
      expect(wrongYear.body.data).toEqual([]);
      for (const yearId of [otherSchoolYearId, academicYearId]) {
        const foreign = await other.get('/api/timetable').query({ ...filter, academicYearId: yearId });
        expectStatus(foreign, 200);
        expect(foreign.body.data).toEqual([]);
      }
    }
    const unfiltered = await other.get('/api/timetable');
    expectStatus(unfiltered, 200);
    expect(unfiltered.body.data).toEqual([]);

    const ownedReadiness = await agent.get(`${base}/readiness`);
    expectStatus(ownedReadiness, 200);
    expect(ownedReadiness.body.data).toMatchObject({ ok: true, blocking: [] });
    const ownedState = await agent.get(`${base}/state`);
    expectStatus(ownedState, 200);
    expect(ownedState.body.data.lessons).toHaveLength(2);
    expect(ownedState.body.data.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: publishedId, status: 'published' }),
      expect.objectContaining({ id: draftId, status: 'draft' }),
    ]));

    for (const [client, yearId] of [[other, otherSchoolYearId], [agent, secondYearId]] as const) {
      const query = { academicYearId: yearId };
      const state = await client.get(`${base}/state`).query(query);
      expectStatus(state, 200);
      expect(state.body.data).toMatchObject({ lessons: [], versions: [] });
      const list = await client.get(versions).query(query);
      expectStatus(list, 200);
      expect(list.body.data).toEqual([]);
      const readiness = await client.get(`${base}/readiness`).query(query);
      expectStatus(readiness, 200);
      expect(readiness.body.data).toMatchObject({
        ok: false, blocking: expect.arrayContaining([expect.objectContaining({ code: 'no_lessons' })]),
      });
      await expectVersionsHidden(client, yearId, draftId, publishedId, blockId);

      const lesson = `${base}/lessons/${lessonIds[0]}`;
      expectStatus(await client.patch(lesson).query(query).send({
        subjectId: subjectIds[0], sectionIds: [sectionIds[0]],
        parts: [{ teacherIds: [teacherIds[0]], pattern: [{ count: 1, length: 1 }] }],
      }), 404);
      expectStatus(await client.delete(lesson).query(query), 404);
      expectStatus(await client.post(`${lesson}/copy`).query(query).send({ sectionIds: [sectionIds[1]] }), 404);
    }

    for (const path of ['state', 'readiness', 'versions']) {
      expectStatus(await other.get(`${base}/${path}`).query({ academicYearId }), 404);
    }
    const blocked = [{ day: 1, period: 1 }];
    expectStatus(await other.patch(`${base}/availability/staff/${teacherIds[0]}`).send({ blocked }), 404);
    expectStatus(await other.patch(`${base}/availability/section/${sectionIds[0]}`).send({ blocked }), 404);
    expectStatus(await other.patch(`${base}/availability/room/${room.id}`).send({ blocked }), 404);
    expectStatus(await other.patch(`${base}/rooms/${room.id}`).send({ groupId: null }), 404);
    expectStatus(await other.patch(`${base}/rooms/${otherRoom.id}`).send({ groupId }), 400);
    expectStatus(await other.delete(`${base}/room-groups/${groupId}`), 404);
    expectStatus(await other.patch(`${base}/availability/room/${otherRoom.id}`).query({ academicYearId }).send({ blocked }), 404);

    // Rooms are shared within a school. A room's availability belongs to its planner year.
    const roomAvailability = await agent.patch(`${base}/availability/room/${room.id}`)
      .query({ academicYearId: secondYearId }).send({ blocked });
    expectStatus(roomAvailability, 200);
    const secondYearState = await agent.get(`${base}/state`).query({ academicYearId: secondYearId });
    expectStatus(secondYearState, 200);
    expect(secondYearState.body.data).toMatchObject({
      availability: { room: { [room.id.toString()]: blocked } },
      rooms: [expect.objectContaining({ id: room.id.toString(), groupId })],
    });
    const otherSchoolState = await other.get(`${base}/state`);
    expectStatus(otherSchoolState, 200);
    expect(otherSchoolState.body.data).toMatchObject({
      availability: { staff: {}, section: {}, room: {} }, roomGroups: [],
      rooms: [expect.objectContaining({ id: otherRoom.id.toString(), groupId: null })],
      lookups: { sections: [], staff: [], subjects: [] },
    });
    const unchanged = await agent.get(`${base}/state`);
    expectStatus(unchanged, 200);
    expect(unchanged.body.data).toEqual(ownedState.body.data);
    const active = await agent.get('/api/timetable').query({ academicYearId, status: 'active' });
    expectStatus(active, 200);
    expect(active.body.data).toHaveLength(2);
  });

  it('answers 404 when one school sends another school\'s academic year to any planner route', async () => {
    const a = await createPlannerSchool('planner-year-a', smallPlannerSample());
    const b = await createPlannerSchool('planner-year-b', smallPlannerSample());
    expect(a.academicYearId).not.toBe(b.academicYearId);
    const foreignYear = { academicYearId: a.academicYearId };
    const ownYear = { academicYearId: b.academicYearId };

    const aGenerated = await a.agent.post(`${base}/generate`).send({ seed: 42, budgetMs: 200 });
    expectStatus(aGenerated, 201);
    const aVersionId = aGenerated.body.data.version.id as string;
    const bGenerated = await b.agent.post(`${base}/generate`).send({ seed: 42, budgetMs: 200 });
    expectStatus(bGenerated, 201);
    const bVersionId = bGenerated.body.data.version.id as string;
    const bRoomGroup = await b.agent.post(`${base}/room-groups`).send({ name: 'School B labs' });
    expectStatus(bRoomGroup, 201);
    const bGroupId = bRoomGroup.body.data.id as string;

    // Positive controls: every id below is valid in the school that owns it, so the 404s that follow
    // can only come from the year belonging to someone else (not from a broken helper or a bad id).
    const aVersion = await a.agent.get(`${versions}/${aVersionId}`).query(foreignYear);
    expectStatus(aVersion, 200);
    expect(aVersion.body.data.version).toMatchObject({ id: aVersionId });
    expectStatus(await a.agent.get(`${versions}/${aVersionId}`), 200);
    expectStatus(await b.agent.get(`${versions}/${bVersionId}`).query(ownYear), 200);
    expectStatus(await b.agent.get(`${versions}/${bVersionId}`), 200);
    expectStatus(await b.agent.get(`${versions}/${bVersionId}/publish-preview`).query(ownYear), 200);
    expectStatus(await a.agent.patch(`${base}/availability/staff/${a.teacherIds[0]}`).query(foreignYear)
      .send({ blocked: [] }), 200);
    expectStatus(await b.agent.patch(`${base}/availability/staff/${b.teacherIds[0]}`).query(ownYear)
      .send({ blocked: [] }), 200);
    expectStatus(await b.agent.patch(`${base}/sections/${b.sectionIds[0]}/excluded`).query(ownYear)
      .send({ excluded: false }), 200);

    const aBefore = await a.agent.get(`${base}/state`);
    const bBefore = await b.agent.get(`${base}/state`);
    expectStatus(aBefore, 200);
    expectStatus(bBefore, 200);

    // School B sends A's year with its own, perfectly valid, staff, section, lesson and version ids.
    const blocked = [{ day: 1, period: 1 }];
    const lessonBody = {
      subjectId: b.subjectIds[0], sectionIds: [b.sectionIds[0]],
      parts: [{ teacherIds: [b.teacherIds[0]], pattern: [{ count: 1, length: 1 }] }],
    };
    const bell = {
      dayTypes: [{
        id: 'weekday', name: 'Weekdays', days: [1, 2, 3, 4, 5],
        periods: [{ id: 'p1', name: 'Period 1', startsAt: '09:00', endsAt: '09:40' }],
      }],
    };
    const bVersion = `${versions}/${bVersionId}`;
    const requests: [string, () => Promise<Response>][] = [
      ['GET /state', () => b.agent.get(`${base}/state`).query(foreignYear)],
      ['GET /readiness', () => b.agent.get(`${base}/readiness`).query(foreignYear)],
      ['GET /versions', () => b.agent.get(versions).query(foreignYear)],
      ['PATCH /bell', () => b.agent.patch(`${base}/bell`).query(foreignYear).send(bell)],
      ['PATCH /rules', () => b.agent.patch(`${base}/rules`).query(foreignYear).send({ defaults: {}, teachers: {}, sections: {} })],
      ['PATCH /availability/staff/:id', () => b.agent.patch(`${base}/availability/staff/${b.teacherIds[0]}`)
        .query(foreignYear).send({ blocked })],
      ['PATCH /availability/section/:id', () => b.agent.patch(`${base}/availability/section/${b.sectionIds[0]}`)
        .query(foreignYear).send({ blocked })],
      ['PATCH /sections/:id/excluded (own section)', () => b.agent.patch(`${base}/sections/${b.sectionIds[0]}/excluded`)
        .query(foreignYear).send({ excluded: true })],
      ["PATCH /sections/:id/excluded (A's section)", () => b.agent.patch(`${base}/sections/${a.sectionIds[0]}/excluded`)
        .query(foreignYear).send({ excluded: true })],
      ["PATCH /sections/:id/excluded (A's section, B's own year)", () => b.agent.patch(`${base}/sections/${a.sectionIds[0]}/excluded`)
        .query(ownYear).send({ excluded: true })],
      ['POST /room-groups', () => b.agent.post(`${base}/room-groups`).query(foreignYear).send({ name: 'Foreign labs' })],
      ['DELETE /room-groups/:id', () => b.agent.delete(`${base}/room-groups/${bGroupId}`).query(foreignYear)],
      ['POST /lessons', () => b.agent.post(`${base}/lessons`).query(foreignYear).send(lessonBody)],
      ['PATCH /lessons/:id', () => b.agent.patch(`${base}/lessons/${b.lessonIds[0]}`).query(foreignYear).send(lessonBody)],
      ['DELETE /lessons/:id', () => b.agent.delete(`${base}/lessons/${b.lessonIds[0]}`).query(foreignYear)],
      ['POST /lessons/:id/copy', () => b.agent.post(`${base}/lessons/${b.lessonIds[0]}/copy`).query(foreignYear)
        .send({ sectionIds: [b.sectionIds[1]] })],
      ['POST /generate', () => b.agent.post(`${base}/generate`).query(foreignYear).send({ seed: 42, budgetMs: 200 })],
      ['POST /versions', () => b.agent.post(versions).query(foreignYear).send({ name: 'Foreign draft' })],
      ['GET /versions/:id', () => b.agent.get(bVersion).query(foreignYear)],
      ['GET /versions/:id/publish-preview', () => b.agent.get(`${bVersion}/publish-preview`).query(foreignYear)],
      ['POST /versions/:id/publish', () => b.agent.post(`${bVersion}/publish`).query(foreignYear)
        .send({ effectiveFrom: '2026-06-01' })],
      ['POST /versions/:id/restore', () => b.agent.post(`${bVersion}/restore`).query(foreignYear).send({})],
    ];
    for (const [label, send] of requests) {
      const response = await send();
      expect(response.status, `${label} with another school's academic year: ${response.body.message ?? ''}`).toBe(404);
    }

    // The refused requests changed nothing in either school.
    const aAfter = await a.agent.get(`${base}/state`);
    const bAfter = await b.agent.get(`${base}/state`);
    expectStatus(aAfter, 200);
    expectStatus(bAfter, 200);
    expect(aAfter.body.data).toEqual(aBefore.body.data);
    expect(bAfter.body.data).toEqual(bBefore.body.data);
    expectStatus(await b.agent.delete(`${base}/room-groups/${bGroupId}`).query(ownYear), 204);
  });
});
