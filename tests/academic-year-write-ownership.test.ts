import type { Response } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AuthedAgent, currentAcademicYearId, signupAndLogin, uniqueSlug } from './helpers';

async function create(agent: AuthedAgent, path: string, input: object): Promise<string> {
  const response = await agent.post(path).send(input);
  expect(response.status, path).toBe(201);
  return response.body.data.id as string;
}

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  await create(agent, '/api/organizations', { name: tag, slug });
  expect((await switchOrganization(slug)).status).toBe(200);
  return { agent, yearId: await currentAcademicYearId(agent) };
}

function expectForeignYear(response: Response) {
  expect(response.status).toBe(404);
  expect(response.body.message).toBe('Academic year not found');
}

const staffInput = {
  firstName: 'Priya',
  staffType: 'teaching',
  employmentType: 'full_time',
  joinedOn: '2026-06-01',
  createLogin: false,
};

describe('academic year isolation on writes', () => {
  let agent: AuthedAgent;
  let yearId: string;
  let foreignYearId: string;
  let classId: string;

  beforeAll(async () => {
    ({ agent, yearId } = await setupSchool('year-writes'));
    ({ yearId: foreignYearId } = await setupSchool('year-writes-foreign'));
    classId = await create(agent, '/api/classes', { gradeLevel: 5, name: 'Grade 5', code: 'G5' });
  });

  it('scopes staff, section-teacher, timetable and homework creation to the school', async () => {
    const subjectId = await create(agent, '/api/subjects', {
      code: 'MATH',
      name: 'Mathematics',
      subjectType: 'core',
    });
    const subjects = await agent
      .put('/api/classes/' + classId + '/subjects')
      .send({ subjects: [{ subjectId, examMarks: 100, internalMarks: 0 }] });
    expect(subjects.status).toBe(200);
    const sectionId = await create(agent, '/api/sections', { classId, name: 'A', capacity: 30 });
    const teacherId = await create(agent, '/api/staff', staffInput);
    const timeSlotId = await create(agent, '/api/time-slots', {
      name: 'Period 1',
      dayType: 'usual',
      days: [1],
      sequence: 1,
      startsAt: '09:00',
      endsAt: '09:40',
    });

    expectForeignYear(
      await agent.post('/api/staff').send({
        ...staffInput,
        assignments: [{ classId, subjectId }],
        academicYearId: foreignYearId,
      }),
    );

    const assignment = { sectionId, subjectId, teacherId };
    expectForeignYear(
      await agent.post('/api/section-teachers').send({
        ...assignment,
        academicYearId: foreignYearId,
      }),
    );
    await create(agent, '/api/section-teachers', { ...assignment, academicYearId: yearId });

    const entry = { sectionId, subjectId, timeSlotId, dayOfWeek: 1, effectiveFrom: '2026-06-01' };
    expectForeignYear(
      await agent.post('/api/timetable').send({
        ...entry,
        teacherId,
        academicYearId: foreignYearId,
      }),
    );
    const manual = await agent.post('/api/timetable').send({ ...entry, academicYearId: yearId });
    expect(manual.status).toBe(201);
    expect(manual.body.data.teacherId).toBe(teacherId);

    for (const path of ['/api/homework', '/api/homework-plus']) {
      expectForeignYear(
        await agent.post(path).send({
          ...assignment,
          academicYearId: foreignYearId,
          title: 'Practice problems',
          assignedOn: '2026-06-01',
          dueAt: '2026-06-03T17:00:00Z',
        }),
      );
    }
  });

  it('rejects foreign years on admission creation and update', async () => {
    const application = {
      classId,
      firstName: 'Diya',
      lastName: 'Menon',
      dob: '2016-01-15',
      guardianName: 'Kiran Menon',
      guardianPhone: '9000000001',
      source: 'walk_in',
    };
    expectForeignYear(
      await agent.post('/api/admissions').send({ ...application, academicYearId: foreignYearId }),
    );
    const id = await create(agent, '/api/admissions', { ...application, academicYearId: yearId });
    expectForeignYear(await agent.patch('/api/admissions/' + id).send({ academicYearId: foreignYearId }));

    const updated = await agent.patch('/api/admissions/' + id).send({ previousClass: 'Class 4' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.academicYearId).toBe(yearId);
  });

  it('validates calendar years and lets callers omit or clear them', async () => {
    const event = {
      title: 'School holiday',
      eventType: 'holiday',
      startsAt: '2026-08-15T00:00:00Z',
      endsAt: '2026-08-15T23:59:59Z',
    };
    expectForeignYear(
      await agent.post('/api/calendar-events').send({ ...event, academicYearId: foreignYearId }),
    );
    const noYear = await agent.post('/api/calendar-events').send(event);
    expect(noYear.status).toBe(201);
    expect(noYear.body.data.academicYearId).toBeNull();

    const id = await create(agent, '/api/calendar-events', { ...event, academicYearId: yearId });
    const path = '/api/calendar-events/' + id;
    expectForeignYear(await agent.patch(path).send({ academicYearId: foreignYearId }));

    const updated = await agent.patch(path).send({ title: 'School closed' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.academicYearId).toBe(yearId);
    const cleared = await agent.patch(path).send({ academicYearId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.academicYearId).toBeNull();
  });

  it('rejects foreign leave balances and prevents bypassing a deduction with a foreign year', async () => {
    const staffId = await create(agent, '/api/staff', staffInput);
    const leaveTypeId = await create(agent, '/api/leave-types', {
      code: 'YR',
      name: 'Yearly leave',
      applicableTo: 'staff',
      leaveCategory: 'casual',
      accrualBasis: 'annual',
    });
    const nonCurrentYearId = await create(agent, '/api/academic-years', {
      name: '2099-00',
      startsOn: '2099-06-01',
      endsOn: '2100-05-31',
    });
    const balance = { staffId, leaveTypeId, allocated: 10, used: 0, carriedForward: 0 };
    expectForeignYear(
      await agent.put('/api/leave-balances').send({ ...balance, academicYearId: foreignYearId }),
    );
    const saved = await agent
      .put('/api/leave-balances')
      .send({ ...balance, academicYearId: nonCurrentYearId });
    expect(saved.status).toBe(200);

    const requestId = await create(agent, '/api/leave-requests', {
      staffId,
      leaveTypeId,
      fromDate: '2026-09-10',
      toDate: '2026-09-11',
      days: 2,
      durationType: 'full_day',
      reason: 'Personal work',
    });
    const path = '/api/leave-requests/' + requestId + '/decide';
    expectForeignYear(await agent.post(path).send({ decision: 'approved', academicYearId: foreignYearId }));

    const approval = await agent.post(path).send({ decision: 'approved' });
    expect(approval.status).toBe(200);
    const result = await agent.get('/api/leave-balances/' + saved.body.data.id);
    expect(result.status).toBe(200);
    expect(Number(result.body.data.used)).toBe(2);
  });

  it('scopes assignments and invoice writes, including billing and invoice generation', async () => {
    const studentId = await create(agent, '/api/students', {
      firstName: 'Meera',
      lastName: 'Iyer',
      dob: '2014-08-19',
      admittedOn: '2026-06-01',
    });
    const routeId = await create(agent, '/api/transport-routes', { code: 'R1', name: 'School route' });
    const pickupPointId = await create(agent, '/api/pickup-points', {
      routeId,
      name: 'School gate',
      sequence: 1,
      monthlyFee: 500,
    });
    const transport = { academicYearId: foreignYearId, routeId, pickupPointId };
    expectForeignYear(await agent.post('/api/transport-assignments').send({ ...transport, studentId }));
    expectForeignYear(
      await agent.post('/api/transport-billing/requests/' + studentId + '/assign').send(transport),
    );

    const feeTypeId = await create(agent, '/api/fee-types', {
      code: 'TUI',
      name: 'Tuition',
      category: 'school',
      frequency: 'annual',
    });
    const structure = {
      classId,
      name: 'Grade 5 fees',
      frequency: 'annual',
      items: [{ feeTypeId, amount: 300 }],
    };
    expectForeignYear(
      await agent.post('/api/fee-structures').send({ ...structure, academicYearId: foreignYearId }),
    );
    const feeStructureId = await create(agent, '/api/fee-structures', {
      ...structure,
      academicYearId: yearId,
    });
    expectForeignYear(
      await agent.patch('/api/fee-structures/' + feeStructureId).send({ academicYearId: foreignYearId }),
    );

    const invoice = { studentId, issuedOn: '2026-06-01', dueOn: '2026-06-30', academicYearId: foreignYearId };
    expectForeignYear(
      await agent.post('/api/invoices').send({
        ...invoice,
        lines: [{ lineType: 'fee', feeTypeId, unitAmount: 300 }],
      }),
    );
    expectForeignYear(
      await agent.post('/api/invoices/generate-from-structure').send({ ...invoice, feeStructureId }),
    );
  });
});
