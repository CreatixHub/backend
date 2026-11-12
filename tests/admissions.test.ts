import { describe, expect, it } from 'vitest';
import { signupAndLogin, uniqueEmail, uniqueSlug, VALID_PASSWORD } from './helpers';

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  await switchOrganization(slug);

  const cls = await agent.post('/api/classes').send({ gradeLevel: 5, name: 'Grade 5', code: `G5-${slug.slice(-4).toUpperCase()}` });
  const stf = await agent.post('/api/staff').send({
    firstName: 'Anita',
    lastName: 'Rao',
    staffType: 'non_teaching',
    employmentType: 'full_time',
    joinedOn: '2026-06-01',
  });

  return {
    agent,
    slug,
    classId: cls.body.data.id as string,
    staffId: stf.body.data.id as string,
  };
}

describe('admissions module', () => {
  it('creates, lists, retrieves and updates admission applications with initial status history', async () => {
    const { agent, classId, staffId } = await setupSchool('adm-crud');

    const createRes = await agent.post('/api/admissions').send({
      academicYearId: '1',
      classId,
      firstName: 'Aarav',
      lastName: 'Sharma',
      dob: '2016-04-12',
      gender: 'male',
      email: uniqueEmail('aarav'),
      phone: '9876543210',
      bloodGroup: 'B+',
      religionId: '1',
      socialCategory: 'general',
      fatherName: 'Rajesh Sharma',
      fatherPhone: '9876543211',
      fatherOccupation: 'Engineer',
      motherName: 'Sunita Sharma',
      motherPhone: '9876543212',
      guardianName: 'Rajesh Sharma',
      guardianPhone: '9876543211',
      guardianEmail: uniqueEmail('rajesh'),
      previousSchool: 'Little Angels',
      previousClass: 'Grade 4',
      addressLine1: '12 Lake Road',
      cityId: '1',
      postalCode: '600001',
      status: 'enquiry',
      appliedOn: '2026-11-01',
      assignedToStaffId: staffId,
      needsTransport: true,
      needsHostel: false,
      applicationFee: 500,
      feePaid: false,
      source: 'website',
      note: 'Initial walk-in enquiry logged online',
    });

    expect(createRes.status).toBe(201);
    const adm = createRes.body.data;
    expect(adm.applicationNo).toMatch(/^APP-2026-\d{4}$/);
    expect(adm.status).toBe('enquiry');
    expect(adm.source).toBe('website');
    expect(adm.applicationFee).toBe('500.00');
    expect(adm.history).toHaveLength(1);
    expect(adm.history[0].fromStatus).toBeNull();
    expect(adm.history[0].toStatus).toBe('enquiry');

    const listRes = await agent.get('/api/admissions?q=Aarav&status=enquiry&source=website');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);
    expect(listRes.body.data[0].id).toBe(adm.id);
    expect(listRes.body.meta.total).toBe(1);

    const getRes = await agent.get(`/api/admissions/${adm.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.className).toBe('Grade 5');
    expect(getRes.body.data.assignedToStaffName).toBe('Anita Rao');
    expect(getRes.body.data.history).toHaveLength(1);

    const updateRes = await agent.patch(`/api/admissions/${adm.id}`).send({
      feePaid: true,
      feePaidOn: '2026-11-02',
      feePaymentMethod: 'upi',
      previousClass: 'Class 4',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.feePaid).toBe(true);
    expect(updateRes.body.data.feePaymentMethod).toBe('upi');
  });

  it('rejects duplicate applicationNo and invalid validation/missing records', async () => {
    const { agent, classId } = await setupSchool('adm-val');

    const r1 = await agent.post('/api/admissions').send({
      applicationNo: 'APP-CUSTOM-1',
      academicYearId: '1',
      classId,
      firstName: 'Diya',
      lastName: 'Menon',
      dob: '2016-01-15',
      guardianName: 'Kiran Menon',
      guardianPhone: '9000000001',
      source: 'walk_in',
    });
    expect(r1.status).toBe(201);

    const dup = await agent.post('/api/admissions').send({
      applicationNo: 'APP-CUSTOM-1',
      academicYearId: '1',
      classId,
      firstName: 'Other',
      lastName: 'Child',
      dob: '2016-02-20',
      guardianName: 'Other Parent',
      guardianPhone: '9000000002',
      source: 'referral',
    });
    expect(dup.status).toBe(409);

    const bad = await agent.post('/api/admissions').send({
      academicYearId: '1',
      classId,
      firstName: 'Bad',
      lastName: 'Date',
      dob: '2026-02-31',
      guardianName: 'Parent',
      guardianPhone: '9000000003',
      source: 'invalid_source',
    });
    expect(bad.status).toBe(400);

    const missing = await agent.get('/api/admissions/999999999');
    expect(missing.status).toBe(404);
  });

  it('tracks status transitions and atomically creates student + guardian when accepted', async () => {
    const { agent, classId } = await setupSchool('adm-accept');

    const created = await agent.post('/api/admissions').send({
      academicYearId: '1',
      classId,
      firstName: 'Kabir',
      lastName: 'Verma',
      dob: '2015-09-10',
      gender: 'male',
      bloodGroup: 'A+',
      fatherName: 'Vikram Verma',
      fatherPhone: '9888877777',
      guardianName: 'Vikram Verma',
      guardianPhone: '9888877777',
      guardianEmail: uniqueEmail('vikram'),
      addressLine1: '44 Park Ave',
      cityId: '1',
      postalCode: '600002',
      appliedOn: '2026-11-05',
      source: 'referral',
    });
    expect(created.status).toBe(201);
    const admId = created.body.data.id as string;

    const s1 = await agent.post(`/api/admissions/${admId}/status`).send({
      status: 'document_review',
      note: 'Birth certificate received',
    });
    expect(s1.status).toBe(200);
    expect(s1.body.data.status).toBe('document_review');

    const s2 = await agent.post(`/api/admissions/${admId}/status`).send({
      status: 'waitlisted',
      waitlistPosition: 2,
      note: 'Waiting for seat confirmation',
    });
    expect(s2.status).toBe(200);
    expect(s2.body.data.waitlistPosition).toBe(2);

    const s3 = await agent.post(`/api/admissions/${admId}/status`).send({
      status: 'offered',
      decisionNotes: 'Seat available in Grade 5',
    });
    expect(s3.status).toBe(200);
    expect(s3.body.data.waitlistPosition).toBeNull();

    const accepted = await agent.post(`/api/admissions/${admId}/accept`).send({
      decisionNotes: 'Family confirmed enrollment',
      admittedOn: '2026-11-12',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.status).toBe('accepted');
    expect(accepted.body.data.studentId).toBeTruthy();
    expect(accepted.body.data.student.admissionId).toBe(admId);
    expect(accepted.body.data.student.admissionNo).toMatch(/^STU-2026-\d{4}$/);
    expect(accepted.body.data.student.primaryGuardianId).toBeTruthy();
    expect(accepted.body.data.history).toHaveLength(5);
    expect(accepted.body.data.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'applied',
      'document_review',
      'waitlisted',
      'offered',
      'accepted',
    ]);

    // Verify linked student & primary guardian exist in students module
    const studentRes = await agent.get(`/api/students/${accepted.body.data.studentId}`);
    expect(studentRes.status).toBe(200);
    expect(studentRes.body.data.admission.id).toBe(admId);
    expect(studentRes.body.data.guardians).toHaveLength(1);
    expect(studentRes.body.data.guardians[0].isPrimary).toBe(true);
    expect(studentRes.body.data.guardians[0].canPickUp).toBe(true);

    // Accepted admission cannot be re-transitioned or deleted
    const reStatus = await agent.post(`/api/admissions/${admId}/status`).send({ status: 'rejected' });
    expect(reStatus.status).toBe(409);
    const delAccepted = await agent.delete(`/api/admissions/${admId}`);
    expect(delAccepted.status).toBe(409);
  });

  it('supports rejection, withdrawal, soft delete, permissions and cross-org isolation', async () => {
    const schoolA = await setupSchool('adm-iso-a');
    const schoolB = await setupSchool('adm-iso-b');

    const created = await schoolA.agent.post('/api/admissions').send({
      academicYearId: '1',
      classId: schoolA.classId,
      firstName: 'Riya',
      lastName: 'Das',
      dob: '2016-07-01',
      guardianName: 'Arjun Das',
      guardianPhone: '9111111111',
      source: 'event',
    });
    const admId = created.body.data.id as string;

    // Cross-organization isolation: School B gets 404 on School A's admission and 400 trying to use School A's classId
    expect((await schoolB.agent.get(`/api/admissions/${admId}`)).status).toBe(404);
    expect((await schoolB.agent.patch(`/api/admissions/${admId}`).send({ phone: '9999999999' })).status).toBe(404);
    expect((await schoolB.agent.post(`/api/admissions/${admId}/status`).send({ status: 'rejected' })).status).toBe(404);
    expect((await schoolB.agent.delete(`/api/admissions/${admId}`)).status).toBe(404);
    expect(
      (
        await schoolB.agent.post('/api/admissions').send({
          academicYearId: '1',
          classId: schoolA.classId,
          firstName: 'Leak',
          lastName: 'Attempt',
          dob: '2016-01-01',
          guardianName: 'Parent',
          guardianPhone: '9111111112',
          source: 'walk_in',
        })
      ).status,
    ).toBe(400);

    // Permission checks: add a teacher (no admissions.*) and a receptionist (view/create/edit, no delete)
    const teacherEmail = uniqueEmail('adm-teacher');
    const recepEmail = uniqueEmail('adm-recep');
    await schoolA.agent.post('/api/members').send({ email: teacherEmail, fullName: 'T One', password: VALID_PASSWORD, roles: ['teacher'] });
    await schoolA.agent.post('/api/members').send({ email: recepEmail, fullName: 'R One', password: VALID_PASSWORD, roles: ['receptionist'] });

    const { agent: teacherAgent } = await signupAndLogin('adm-t-login');
    const tLogin = await teacherAgent.post('/api/auth/login').send({ email: teacherEmail, password: VALID_PASSWORD, organization: schoolA.slug });
    const tToken = tLogin.body.data.accessToken as string;
    const tRes = await teacherAgent.get('/api/admissions').set('Authorization', `Bearer ${tToken}`);
    expect(tRes.status).toBe(403);

    const { agent: recepAgent } = await signupAndLogin('adm-r-login');
    const rLogin = await recepAgent.post('/api/auth/login').send({ email: recepEmail, password: VALID_PASSWORD, organization: schoolA.slug });
    const rToken = rLogin.body.data.accessToken as string;
    expect((await recepAgent.get(`/api/admissions/${admId}`).set('Authorization', `Bearer ${rToken}`)).status).toBe(200);
    expect((await recepAgent.delete(`/api/admissions/${admId}`).set('Authorization', `Bearer ${rToken}`)).status).toBe(403);

    // Reject & soft-delete
    const rej = await schoolA.agent.post(`/api/admissions/${admId}/status`).send({
      status: 'rejected',
      rejectionReason: 'Incomplete age criteria',
    });
    expect(rej.status).toBe(200);
    expect(rej.body.data.rejectionReason).toBe('Incomplete age criteria');

    expect((await schoolA.agent.delete(`/api/admissions/${admId}`)).status).toBe(204);
    expect((await schoolA.agent.get(`/api/admissions/${admId}`)).status).toBe(404);
  });
});
