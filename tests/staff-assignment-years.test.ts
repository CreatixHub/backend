import { describe, expect, it } from 'vitest';
import { currentAcademicYearId, signupAndLogin, uniqueSlug } from './helpers';

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const organization = await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  expect(organization.status).toBe(201);
  await switchOrganization(slug);
  return { agent, yearId: await currentAcademicYearId(agent) };
}

describe('teacher assignments by academic year', () => {
  it('lists and removes current assignments without deleting the prior year', async () => {
    const { agent, yearId: previousYearId } = await setupSchool('staff-assignment-years');
    const { yearId: foreignYearId } = await setupSchool('staff-assignment-foreign-year');

    const teacher = await agent.post('/api/staff').send({
      firstName: 'Priya',
      staffType: 'teaching',
      employmentType: 'full_time',
      joinedOn: '2026-06-01',
      createLogin: false,
    });
    expect(teacher.status).toBe(201);
    const classResponse = await agent.post('/api/classes').send({ gradeLevel: 5, name: 'Grade 5', code: 'G5' });
    expect(classResponse.status).toBe(201);
    const subject = await agent.post('/api/subjects').send({ code: 'MATH', name: 'Mathematics', subjectType: 'core' });
    expect(subject.status).toBe(201);

    const classId = classResponse.body.data.id as string;
    const subjectId = subject.body.data.id as string;
    const url = `/api/staff/${teacher.body.data.id as string}/assignments`;
    const deleteUrl = `${url}/${classId}/${subjectId}`;
    const assignments = [{ classId, subjectId }];
    expect((await agent.post(url).send({ academicYearId: previousYearId, assignments })).status).toBe(200);

    const nextYear = await agent.post('/api/academic-years').send({
      name: '2099-00',
      startsOn: '2099-06-01',
      endsOn: '2100-05-31',
      isCurrent: true,
    });
    expect(nextYear.status).toBe(201);
    const currentYearId = nextYear.body.data.id as string;
    const currentYearQuery = `academicYearId=${currentYearId}`;

    const empty = await agent.get(`${url}?${currentYearQuery}`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect((await agent.post(url).send({ academicYearId: currentYearId, assignments })).status).toBe(200);

    const current = await agent.get(`${url}?${currentYearQuery}`);
    expect(current.status).toBe(200);
    expect(current.body.data).toEqual([expect.objectContaining({ academicYearId: currentYearId })]);

    expect((await agent.get(`${url}?academicYearId=${foreignYearId}`)).status).toBe(404);
    expect((await agent.post(url).send({ academicYearId: foreignYearId, assignments })).status).toBe(404);
    expect((await agent.delete(`${deleteUrl}?academicYearId=${foreignYearId}`)).status).toBe(404);
    expect((await agent.delete(`${deleteUrl}?${currentYearQuery}`)).status).toBe(204);

    expect((await agent.post(url).send({ academicYearId: currentYearId, assignments })).status).toBe(200);
    expect((await agent.delete(deleteUrl)).status).toBe(204);

    const remaining = await agent.get(url);
    expect(remaining.status).toBe(200);
    expect(remaining.body.data).toEqual([expect.objectContaining({ academicYearId: previousYearId })]);
  });
});
