import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db';
import { classrooms, timetableEntries, timetableVersions } from '../src/db/schema';
import { currentAcademicYearId, signupAndLogin, uniqueSlug } from './helpers';

// timetable_entries can hold rows written by the planner (no subject/teacher, a title, source = 'planner'),
// the /api/timetable routes still need a subject and a teacher, and an active lesson must run on a day its slot runs.

async function setupSchool(tag: string) {
  const { agent, switchOrganization, body: signup } = await signupAndLogin(tag);
  const userId = BigInt(signup.data.user.id as string);
  const slug = uniqueSlug(tag);
  const org = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(org.status).toBe(201);
  await switchOrganization(slug);
  const tenantId = BigInt(org.body.data.id as string);
  const yearId = await currentAcademicYearId(agent); // the school's own current year (academic_year_id is a real foreign key)

  const subject = await agent.post('/api/subjects').send({ code: 'MATH', name: 'Mathematics', subjectType: 'core' });
  expect(subject.status).toBe(201);
  const subjectId = subject.body.data.id as string;

  const klass = await agent.post('/api/classes').send({ gradeLevel: 5, name: 'Grade 5', code: 'G5' });
  expect(klass.status).toBe(201);
  const classId = klass.body.data.id as string;
  const taught = await agent
    .put(`/api/classes/${classId}/subjects`)
    .send({ subjects: [{ subjectId, examMarks: 100, internalMarks: 0 }] });
  expect(taught.status).toBe(200);

  const sectionIds: string[] = [];
  for (const name of ['A', 'B']) {
    const section = await agent.post('/api/sections').send({ classId, name, capacity: 30 });
    expect(section.status).toBe(201);
    sectionIds.push(section.body.data.id as string);
  }

  const teacher = await agent.post('/api/staff').send({
    firstName: 'Priya',
    lastName: 'Nair',
    staffType: 'teaching',
    employmentType: 'full_time',
    joinedOn: '2026-06-01',
    createLogin: false,
  });
  expect(teacher.status).toBe(201);
  const teacherId = teacher.body.data.id as string;

  // a Mon-Thu period
  const slot = await agent
    .post('/api/time-slots')
    .send({ name: 'Period 1', dayType: 'usual', days: [1, 2, 3, 4], sequence: 1, startsAt: '09:00', endsAt: '09:40' });
  expect(slot.status).toBe(201);
  const timeSlotId = slot.body.data.id as string;

  return { agent, tenantId, userId, yearId, subjectId, sectionIds, teacherId, timeSlotId };
}

// timetable_entries.version_id is a real foreign key, so a planner row that carries one needs a real version
// of the same school and year.
async function insertVersion(s: { tenantId: bigint; userId: bigint; yearId: string }): Promise<bigint> {
  const bell = { weekType: 'weekly', dayTypes: [] };
  const [version] = await db
    .insert(timetableVersions)
    .values({
      tenantId: s.tenantId,
      academicYearId: BigInt(s.yearId),
      name: 'Test version',
      status: 'draft',
      seed: 1,
      bell,
      problem: { days: [1, 2, 3, 4], bell, sections: [], staff: [], rooms: [], availability: {}, rules: {}, lessons: [] },
      fingerprint: 'test',
      settingsRevision: 0,
      createdBy: s.userId,
    })
    .returning({ id: timetableVersions.id });
  return version.id;
}

const plannerRow = (
  s: { tenantId: bigint; yearId: string; sectionIds: string[]; teacherId: string; timeSlotId: string },
  over: Partial<typeof timetableEntries.$inferInsert> = {},
): typeof timetableEntries.$inferInsert => ({
  tenantId: s.tenantId,
  sectionId: BigInt(s.sectionIds[0]),
  subjectId: null,
  teacherId: null,
  title: 'Library',
  source: 'planner',
  timeSlotId: BigInt(s.timeSlotId),
  dayOfWeek: 1,
  academicYearId: BigInt(s.yearId),
  effectiveFrom: '2026-06-01',
  ...over,
});

describe('timetable entries written by the planner', () => {
  it('a planner row with null subject and a title appears in the list as that title', async () => {
    const s = await setupSchool('tt-planner-list');
    await db.insert(timetableEntries).values(plannerRow(s));

    const list = await s.agent.get('/api/timetable');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const row = list.body.data[0];
    expect(row.subjectId).toBeNull();
    expect(row.teacherId).toBeNull();
    expect(row.subjectName).toBe('Library'); // falls back to the title
    expect(row.title).toBe('Library');
    expect(row.source).toBe('planner');
    expect(row.teacherName).toBeNull();
  });

  it('manual create still rejects a missing teacher', async () => {
    const s = await setupSchool('tt-manual-teacher');
    const body = {
      sectionId: s.sectionIds[0],
      subjectId: s.subjectId,
      timeSlotId: s.timeSlotId,
      dayOfWeek: 1,
      academicYearId: s.yearId,
      effectiveFrom: '2026-06-01',
    };

    // no teacher sent and none assigned to the subject for the section
    const missing = await s.agent.post('/api/timetable').send(body);
    expect(missing.status).toBe(400);

    // an explicit null is not accepted either, and neither is a missing subject
    const nullTeacher = await s.agent.post('/api/timetable').send({ ...body, teacherId: null });
    expect(nullTeacher.status).toBe(400);
    const noSubject = await s.agent.post('/api/timetable').send({ ...body, teacherId: s.teacherId, subjectId: undefined });
    expect(noSubject.status).toBe(400);

    // with both it works, and the row is a manual one
    const ok = await s.agent.post('/api/timetable').send({ ...body, teacherId: s.teacherId });
    expect(ok.status).toBe(201);
    expect(ok.body.data.source).toBe('manual');
  });

  it('two active planner rows for one teacher/day/slot in different sections are allowed (combined lessons)', async () => {
    const s = await setupSchool('tt-planner-combined');
    const first = plannerRow(s, { teacherId: BigInt(s.teacherId), title: 'Maths' });
    // a lesson combined across two classes: the same teacher, day and slot, another section
    const second = plannerRow(s, { teacherId: BigInt(s.teacherId), title: 'Maths', sectionId: BigInt(s.sectionIds[1]) });
    await db.insert(timetableEntries).values([first, second]);
    const rows = await db.select().from(timetableEntries).where(and(
      eq(timetableEntries.tenantId, s.tenantId), eq(timetableEntries.teacherId, BigInt(s.teacherId)), eq(timetableEntries.status, 'active'),
    ));
    expect(rows).toHaveLength(2);
  });
});

describe('an active entry must run on a day its time slot runs', () => {
  it('rejects a day the slot does not run on', async () => {
    const s = await setupSchool('tt-slot-days');
    const body = {
      sectionId: s.sectionIds[0],
      subjectId: s.subjectId,
      teacherId: s.teacherId,
      timeSlotId: s.timeSlotId,
      academicYearId: s.yearId,
      effectiveFrom: '2026-06-01',
    };

    // the slot runs Monday to Thursday
    const friday = await s.agent.post('/api/timetable').send({ ...body, dayOfWeek: 5 });
    expect(friday.status).toBe(400);
    expect(friday.body.message).toBe('That time slot does not run on this day');

    const monday = await s.agent.post('/api/timetable').send({ ...body, dayOfWeek: 1 });
    expect(monday.status).toBe(201);

    // moving an active entry onto a day the slot does not run on is refused too
    const moved = await s.agent.patch(`/api/timetable/${monday.body.data.id}`).send({ dayOfWeek: 6 });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toBe('That time slot does not run on this day');
  });
});

describe('planner rows are not editable through /api/timetable', () => {
  const PLANNER_MESSAGE = 'This lesson is managed by the timetable planner. Change it there.';

  async function plannerEntry(s: Awaited<ReturnType<typeof setupSchool>>) {
    const versionId = await insertVersion(s);
    const [row] = await db
      .insert(timetableEntries)
      .values(plannerRow(s, { teacherId: BigInt(s.teacherId), title: 'Maths', versionId }))
      .returning();
    return row;
  }

  const reload = async (tenantId: bigint, id: bigint) => {
    const [row] = await db
      .select()
      .from(timetableEntries)
      .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)));
    return row;
  };

  it('PATCH on a planner row returns 409 and leaves the row unchanged', async () => {
    const s = await setupSchool('tt-planner-patch');
    const row = await plannerEntry(s);

    for (const body of [{ status: 'inactive' }, { dayOfWeek: 2 }, { classroomId: null }]) {
      const res = await s.agent.patch(`/api/timetable/${row.id}`).send(body);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(PLANNER_MESSAGE);
    }

    const after = await reload(s.tenantId, row.id);
    expect(after).toEqual(row); // source, versionId, status, day, everything
    expect(after.source).toBe('planner');
    expect(after.versionId).not.toBeNull();
    expect(after.versionId).toBe(row.versionId);
    expect(after.status).toBe('active');
  });

  it('DELETE on a planner row returns 409 and leaves it active', async () => {
    const s = await setupSchool('tt-planner-delete');
    const row = await plannerEntry(s);

    const res = await s.agent.delete(`/api/timetable/${row.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(PLANNER_MESSAGE);

    const after = await reload(s.tenantId, row.id);
    expect(after.status).toBe('active');
    expect(after.source).toBe('planner');
  });

  it('PATCH on a manual row still works and keeps source manual', async () => {
    const s = await setupSchool('tt-manual-patch');
    const created = await s.agent.post('/api/timetable').send({
      sectionId: s.sectionIds[0],
      subjectId: s.subjectId,
      teacherId: s.teacherId,
      timeSlotId: s.timeSlotId,
      dayOfWeek: 1,
      academicYearId: s.yearId,
      effectiveFrom: '2026-06-01',
    });
    expect(created.status).toBe(201);

    const patched = await s.agent.patch(`/api/timetable/${created.body.data.id}`).send({ dayOfWeek: 2 });
    expect(patched.status).toBe(200);
    expect(patched.body.data.dayOfWeek).toBe(2);
    expect(patched.body.data.source).toBe('manual');

    const removed = await s.agent.delete(`/api/timetable/${created.body.data.id}`);
    expect(removed.status).toBe(204);
  });

  it('an id from another school is still a 404, not a 409', async () => {
    const mine = await setupSchool('tt-planner-own');
    const other = await setupSchool('tt-planner-other');
    const row = await plannerEntry(mine);

    const patch = await other.agent.patch(`/api/timetable/${row.id}`).send({ status: 'inactive' });
    expect(patch.status).toBe(404);
    const del = await other.agent.delete(`/api/timetable/${row.id}`);
    expect(del.status).toBe(404);
  });
});

describe('manual lessons and rooms used by the planner', () => {
  const makeRoom = async (tenantId: bigint, code: string) => {
    const [room] = await db.insert(classrooms).values({ tenantId, code }).returning({ id: classrooms.id });
    return room.id;
  };

  it('a manual lesson cannot use a room that a planner lesson uses as a secondary room', async () => {
    const s = await setupSchool('tt-secondary-room');
    const roomA = await makeRoom(s.tenantId, 'RA');
    const roomB = await makeRoom(s.tenantId, 'RB');
    const roomC = await makeRoom(s.tenantId, 'RC');

    // a planner lesson in section A that uses two rooms: classroomId is the first one, classroomIds holds both
    await db.insert(timetableEntries).values(
      plannerRow(s, { teacherId: BigInt(s.teacherId), title: 'Maths', classroomId: roomA, classroomIds: [roomA, roomB] }),
    );

    // another teacher for the manual lesson, so only the room can clash
    const other = await s.agent.post('/api/staff').send({
      firstName: 'Anil',
      lastName: 'Kumar',
      staffType: 'teaching',
      employmentType: 'full_time',
      joinedOn: '2026-06-01',
      createLogin: false,
    });
    expect(other.status).toBe(201);

    const body = {
      sectionId: s.sectionIds[1],
      subjectId: s.subjectId,
      teacherId: other.body.data.id as string,
      timeSlotId: s.timeSlotId,
      dayOfWeek: 1,
      academicYearId: s.yearId,
      effectiveFrom: '2026-06-01',
    };

    const clash = await s.agent.post('/api/timetable').send({ ...body, classroomId: roomB.toString() });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toBe('This classroom is already in use in that period');

    // the planner lesson's first room is refused as before
    const first = await s.agent.post('/api/timetable').send({ ...body, classroomId: roomA.toString() });
    expect(first.status).toBe(409);
    expect(first.body.message).toBe('This classroom is already in use in that period');

    // a room the planner lesson does not use is fine
    const free = await s.agent.post('/api/timetable').send({ ...body, classroomId: roomC.toString() });
    expect(free.status).toBe(201);
  });
});

describe('changing the weekdays of a time slot', () => {
  it('shrinking a slot\'s days is refused while active lessons use the removed weekday', async () => {
    const s = await setupSchool('tt-slot-shrink');
    const slot = await s.agent
      .post('/api/time-slots')
      .send({ name: 'Period 2', dayType: 'usual', days: [1, 2, 3, 4, 5], sequence: 2, startsAt: '10:00', endsAt: '10:40' });
    expect(slot.status).toBe(201);
    const slotId = slot.body.data.id as string;

    const entry = await s.agent.post('/api/timetable').send({
      sectionId: s.sectionIds[0],
      subjectId: s.subjectId,
      teacherId: s.teacherId,
      timeSlotId: slotId,
      dayOfWeek: 5,
      academicYearId: s.yearId,
      effectiveFrom: '2026-06-01',
    });
    expect(entry.status).toBe(201);

    const refused = await s.agent.patch(`/api/time-slots/${slotId}`).send({ days: [1, 2, 3, 4] });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Remove or move the lessons on Friday that use this time slot first');
    const unchanged = (await s.agent.get('/api/time-slots')).body.data.find((t: { id: string }) => t.id === slotId);
    expect(unchanged.days).toEqual([1, 2, 3, 4, 5]);

    // removing a weekday nobody uses is fine, and so is adding one
    const added = await s.agent.patch(`/api/time-slots/${slotId}`).send({ days: [1, 2, 3, 4, 5, 6] });
    expect(added.status).toBe(200);
    expect(added.body.data.days).toEqual([1, 2, 3, 4, 5, 6]);
    const unused = await s.agent.patch(`/api/time-slots/${slotId}`).send({ days: [1, 2, 3, 4, 5] });
    expect(unused.status).toBe(200);

    // once the lesson is switched off the same change goes through
    const removed = await s.agent.delete(`/api/timetable/${entry.body.data.id}`);
    expect(removed.status).toBe(204);
    const shrunk = await s.agent.patch(`/api/time-slots/${slotId}`).send({ days: [1, 2, 3, 4] });
    expect(shrunk.status).toBe(200);
    expect(shrunk.body.data.days).toEqual([1, 2, 3, 4]);
  });
});
