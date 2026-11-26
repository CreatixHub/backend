import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors';
import type { TenantContext } from '../src/lib/tenant';
import { resolveAcademicYearId } from '../src/modules/academic-years/academicYears.service';
import { app, signupAndLogin, uniqueEmail, uniqueSlug, VALID_PASSWORD } from './helpers';

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const org = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(org.status).toBe(201);
  await switchOrganization(slug);
  const tenant: TenantContext = {
    id: BigInt(org.body.data.id as string),
    slug,
    name: `${tag} School`,
    roles: ['owner'],
    permissions: new Set(['*']),
  };
  return { agent, tenant };
}

describe('academic years', () => {
  it('creating a school creates one current academic year', async () => {
    const { agent } = await setupSchool('ay-new-school');

    const list = await agent.get('/api/academic-years');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const year = list.body.data[0];
    expect(year.isCurrent).toBe(true);
    expect(year.name).toMatch(/^\d{4}-\d{2}$/);
    expect(year.startsOn).toMatch(/^\d{4}-06-01$/);
    expect(year.endsOn).toMatch(/^\d{4}-05-31$/);
    expect(year.tenantId).toBeUndefined(); // never sent to the client

    const current = await agent.get('/api/academic-years/current');
    expect(current.status).toBe(200);
    expect(current.body.data.id).toBe(year.id);
  });

  it('only one year can be current (setting a second current clears the first)', async () => {
    const { agent } = await setupSchool('ay-one-current');
    const first = (await agent.get('/api/academic-years/current')).body.data;

    const created = await agent
      .post('/api/academic-years')
      .send({ name: '2099-00', startsOn: '2099-06-01', endsOn: '2100-05-31' });
    expect(created.status).toBe(201);
    expect(created.body.data.isCurrent).toBe(false); // the school already has a current year

    const switched = await agent.patch(`/api/academic-years/${created.body.data.id}`).send({ isCurrent: true });
    expect(switched.status).toBe(200);
    expect(switched.body.data.isCurrent).toBe(true);

    const list = await agent.get('/api/academic-years');
    const currentOnes = (list.body.data as { id: string; isCurrent: boolean }[]).filter((y) => y.isCurrent);
    expect(currentOnes).toHaveLength(1);
    expect(currentOnes[0].id).toBe(created.body.data.id);
    expect((list.body.data as { id: string; isCurrent: boolean }[]).find((y) => y.id === first.id)!.isCurrent).toBe(false);

    // creating a year with isCurrent: true also clears the previous current one
    const third = await agent
      .post('/api/academic-years')
      .send({ name: '2100-01', startsOn: '2100-06-01', endsOn: '2101-05-31', isCurrent: true });
    expect(third.status).toBe(201);
    const after = await agent.get('/api/academic-years');
    expect((after.body.data as { isCurrent: boolean }[]).filter((y) => y.isCurrent)).toHaveLength(1);
    expect((await agent.get('/api/academic-years/current')).body.data.id).toBe(third.body.data.id);

    // the same name twice in one school is refused
    const dup = await agent
      .post('/api/academic-years')
      .send({ name: '2100-01', startsOn: '2100-06-01', endsOn: '2101-05-31' });
    expect(dup.status).toBe(409);
  });

  it('a year from another school returns 404 on PATCH', async () => {
    const schoolA = await setupSchool('ay-iso-a');
    const schoolB = await setupSchool('ay-iso-b');
    const yearOfA = (await schoolA.agent.get('/api/academic-years/current')).body.data;

    const res = await schoolB.agent.patch(`/api/academic-years/${yearOfA.id}`).send({ isCurrent: true });
    expect(res.status).toBe(404);
    const rename = await schoolB.agent.patch(`/api/academic-years/${yearOfA.id}`).send({ name: 'hijacked' });
    expect(rename.status).toBe(404);

    // School A's year is untouched
    const after = (await schoolA.agent.get('/api/academic-years/current')).body.data;
    expect(after.name).toBe(yearOfA.name);
  });

  it('resolveAcademicYearId rejects a year of another school', async () => {
    const schoolA = await setupSchool('ay-res-a');
    const schoolB = await setupSchool('ay-res-b');
    const yearOfA = BigInt((await schoolA.agent.get('/api/academic-years/current')).body.data.id as string);
    const yearOfB = BigInt((await schoolB.agent.get('/api/academic-years/current')).body.data.id as string);

    // no year asked for -> the school's own current year
    expect(await resolveAcademicYearId(schoolA.tenant)).toBe(yearOfA);
    // its own year -> accepted
    expect(await resolveAcademicYearId(schoolB.tenant, yearOfB)).toBe(yearOfB);
    // somebody else's year -> 404
    await expect(resolveAcademicYearId(schoolB.tenant, yearOfA)).rejects.toMatchObject({ status: 404 });
    await expect(resolveAcademicYearId(schoolB.tenant, yearOfA)).rejects.toBeInstanceOf(HttpError);
  });

  it('GET /current is readable by a member who lacks academics.view', async () => {
    const school = await setupSchool('ay-no-perm');
    const year = (await school.agent.get('/api/academic-years/current')).body.data;

    // the default "student" role has no academics.view
    const email = uniqueEmail('ay-student');
    const member = await school.agent.post('/api/members').send({
      email,
      fullName: 'Plain Member',
      password: VALID_PASSWORD,
      userType: 'student',
      roles: ['student'],
    });
    expect(member.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD, organization: school.tenant.slug });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken as string;

    const current = await request(app).get('/api/academic-years/current').set('Authorization', `Bearer ${token}`);
    expect(current.status).toBe(200);
    expect(current.body.data.id).toBe(year.id);

    // the list still needs academics.view
    const list = await request(app).get('/api/academic-years').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);
  });
});
