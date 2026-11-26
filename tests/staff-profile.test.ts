import { describe, expect, it } from 'vitest';
import { signupAndLogin, uniqueSlug } from './helpers';

// A teacher's teaching profile: primary subject, additional subjects, and the most periods a week.

const MAX_MESSAGE = 'Maximum periods per week must be a whole number from 1 to 35, or left blank.';

type Agent = Awaited<ReturnType<typeof signupAndLogin>>['agent'];

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const org = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(org.status).toBe(201);
  await switchOrganization(slug);
  return agent;
}

async function makeSubject(agent: Agent, code: string, name: string) {
  const res = await agent.post('/api/subjects').send({ code, name, subjectType: 'core' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

const teacher = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Priya',
  lastName: 'Nair',
  staffType: 'teaching',
  employmentType: 'full_time',
  joinedOn: '2026-06-01',
  createLogin: false, // these tests only need a staff row, not a login
  ...extra,
});

describe('staff teaching profile', () => {
  it('1 and 35 are accepted', async () => {
    const agent = await setupSchool('prof-range');
    for (const value of [1, 35]) {
      const created = await agent.post('/api/staff').send(teacher({ maxPeriodsPerWeek: value }));
      expect(created.status).toBe(201);
      expect(created.body.data.maxPeriodsPerWeek).toBe(value);

      const read = await agent.get(`/api/staff/${created.body.data.id}`);
      expect(read.status).toBe(200);
      expect(read.body.data.maxPeriodsPerWeek).toBe(value);
    }

    // a number sent as text is read as a number
    const created = await agent.post('/api/staff').send(teacher({ maxPeriodsPerWeek: '12' }));
    expect(created.status).toBe(201);
    expect(created.body.data.maxPeriodsPerWeek).toBe(12);
  });

  it('0, 36 and 2.5 are rejected with the message above', async () => {
    const agent = await setupSchool('prof-bad');
    const created = await agent.post('/api/staff').send(teacher({ maxPeriodsPerWeek: 20 }));
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    for (const bad of [0, 36, 2.5]) {
      const patched = await agent.patch(`/api/staff/${id}`).send({ maxPeriodsPerWeek: bad });
      expect(patched.status).toBe(400);
      expect(patched.body.message).toBe(MAX_MESSAGE);

      const made = await agent.post('/api/staff').send(teacher({ maxPeriodsPerWeek: bad }));
      expect(made.status).toBe(400);
      expect(made.body.message).toBe(MAX_MESSAGE);
    }

    // nothing was changed by the rejected requests
    const read = await agent.get(`/api/staff/${id}`);
    expect(read.body.data.maxPeriodsPerWeek).toBe(20);
  });

  it('blank clears the maximum', async () => {
    const agent = await setupSchool('prof-blank');
    const created = await agent.post('/api/staff').send(teacher({ maxPeriodsPerWeek: 20 }));
    const id = created.body.data.id as string;

    const cleared = await agent.patch(`/api/staff/${id}`).send({ maxPeriodsPerWeek: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.maxPeriodsPerWeek).toBeNull();
    expect((await agent.get(`/api/staff/${id}`)).body.data.maxPeriodsPerWeek).toBeNull();

    await agent.patch(`/api/staff/${id}`).send({ maxPeriodsPerWeek: 25 });
    const blank = await agent.patch(`/api/staff/${id}`).send({ maxPeriodsPerWeek: '' });
    expect(blank.status).toBe(200);
    expect(blank.body.data.maxPeriodsPerWeek).toBeNull();

    // a teacher saved with no profile at all reads back with no subjects and no limit
    const plain = await agent.post('/api/staff').send(teacher());
    expect(plain.status).toBe(201);
    expect(plain.body.data.primarySubjectId).toBeNull();
    expect(plain.body.data.additionalSubjectIds).toEqual([]);
    expect(plain.body.data.maxPeriodsPerWeek).toBeNull();
  });

  it('the primary subject is removed from the additional list', async () => {
    const agent = await setupSchool('prof-primary');
    const english = await makeSubject(agent, 'ENG', 'English');
    const maths = await makeSubject(agent, 'MATH', 'Mathematics');
    const science = await makeSubject(agent, 'SCI', 'Science');

    const created = await agent
      .post('/api/staff')
      .send(teacher({ primarySubjectId: english, additionalSubjectIds: [english, maths, maths] }));
    expect(created.status).toBe(201);
    expect(created.body.data.primarySubjectId).toBe(english);
    expect(created.body.data.additionalSubjectIds).toEqual([maths]);
    const id = created.body.data.id as string;

    // sending only a new additional list keeps the primary subject and drops it from the list
    const second = await agent.patch(`/api/staff/${id}`).send({ additionalSubjectIds: [english, science] });
    expect(second.status).toBe(200);
    expect(second.body.data.primarySubjectId).toBe(english);
    expect(second.body.data.additionalSubjectIds).toEqual([science]);

    // moving the primary subject onto one that is already additional removes it from the list
    const moved = await agent.patch(`/api/staff/${id}`).send({ primarySubjectId: science });
    expect(moved.status).toBe(200);
    expect(moved.body.data.primarySubjectId).toBe(science);
    expect(moved.body.data.additionalSubjectIds).toEqual([]);

    // a PATCH that does not mention subjects leaves them alone
    await agent.patch(`/api/staff/${id}`).send({ additionalSubjectIds: [english, maths] });
    const other = await agent.patch(`/api/staff/${id}`).send({ maxPeriodsPerWeek: 18 });
    expect(other.body.data.primarySubjectId).toBe(science);
    expect(other.body.data.additionalSubjectIds).toEqual([english, maths]);

    // and the profile shows up in get and list
    const read = await agent.get(`/api/staff/${id}`);
    expect(read.body.data.additionalSubjectIds).toEqual([english, maths]);
    const list = await agent.get('/api/staff');
    const listed = (list.body.data as { id: string; additionalSubjectIds: string[] }[]).find((s) => s.id === id);
    expect(listed?.additionalSubjectIds).toEqual([english, maths]);
  });

  it('a subject of another school is rejected', async () => {
    const mine = await setupSchool('prof-mine');
    const theirs = await setupSchool('prof-theirs');
    const mySubject = await makeSubject(mine, 'ENG', 'English');
    const theirSubject = await makeSubject(theirs, 'ENG', 'English');

    const asPrimary = await mine.post('/api/staff').send(teacher({ primarySubjectId: theirSubject }));
    expect(asPrimary.status).toBe(400);

    const asAdditional = await mine
      .post('/api/staff')
      .send(teacher({ primarySubjectId: mySubject, additionalSubjectIds: [theirSubject] }));
    expect(asAdditional.status).toBe(400);

    const created = await mine.post('/api/staff').send(teacher({ primarySubjectId: mySubject }));
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const patched = await mine.patch(`/api/staff/${id}`).send({ additionalSubjectIds: [theirSubject] });
    expect(patched.status).toBe(400);

    // the failed requests saved nothing
    const read = await mine.get(`/api/staff/${id}`);
    expect(read.body.data.primarySubjectId).toBe(mySubject);
    expect(read.body.data.additionalSubjectIds).toEqual([]);
    const list = await mine.get('/api/staff');
    expect((list.body.data as unknown[]).length).toBe(1);
  });

  it('only teaching staff may carry a profile', async () => {
    const agent = await setupSchool('prof-teaching');
    const english = await makeSubject(agent, 'ENG', 'English');
    const clerk = (extra: Record<string, unknown> = {}) => teacher({ staffType: 'non_teaching', ...extra });

    for (const profile of [{ maxPeriodsPerWeek: 10 }, { primarySubjectId: english }, { additionalSubjectIds: [english] }]) {
      const res = await agent.post('/api/staff').send(clerk(profile));
      expect(res.status).toBe(400);
    }

    const created = await agent.post('/api/staff').send(clerk());
    expect(created.status).toBe(201);
    expect(created.body.data.maxPeriodsPerWeek).toBeNull();
    const id = created.body.data.id as string;

    const patched = await agent.patch(`/api/staff/${id}`).send({ primarySubjectId: english });
    expect(patched.status).toBe(400);

    // a teacher who becomes non-teaching loses the profile
    const prof = await agent
      .post('/api/staff')
      .send(teacher({ primarySubjectId: english, maxPeriodsPerWeek: 20 }));
    expect(prof.status).toBe(201);
    const moved = await agent.patch(`/api/staff/${prof.body.data.id}`).send({ staffType: 'non_teaching' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.primarySubjectId).toBeNull();
    expect(moved.body.data.maxPeriodsPerWeek).toBeNull();
    expect(moved.body.data.additionalSubjectIds).toEqual([]);
  });
});
