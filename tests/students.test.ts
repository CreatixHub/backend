import { describe, expect, it } from 'vitest';
import { signupAndLogin, uniqueEmail, uniqueSlug, VALID_PASSWORD } from './helpers';

async function setupSchool(tag: string) {
  const { agent, switchOrganization } = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  await agent.post('/api/organizations').send({ name: `${tag} School`, slug });
  await switchOrganization(slug);

  const stf = await agent.post('/api/staff').send({
    firstName: 'Rohan',
    lastName: 'Kapoor',
    staffType: 'teaching',
    employmentType: 'full_time',
    joinedOn: '2026-06-01',
  });

  return { agent, slug, staffId: stf.body.data.id as string };
}

describe('students module', () => {
  it('manages student houses, students, status transitions and soft deletion', async () => {
    const { agent, staffId } = await setupSchool('stu-core');

    const houseRes = await agent.post('/api/student-houses').send({
      name: 'Sapphire House',
      color: '#2563EB',
      motto: 'Truth and Courage',
      houseMasterId: staffId,
    });
    expect(houseRes.status).toBe(201);
    const houseId = houseRes.body.data.id as string;

    const dupHouse = await agent.post('/api/student-houses').send({ name: 'Sapphire House' });
    expect(dupHouse.status).toBe(409);

    const createRes = await agent.post('/api/students').send({
      firstName: 'Meera',
      lastName: 'Iyer',
      dob: '2014-08-19',
      gender: 'female',
      bloodGroup: 'O+',
      religionId: '1',
      motherTongueId: '1',
      studentHouseId: houseId,
      admittedOn: '2026-06-01',
    });
    expect(createRes.status).toBe(201);
    const student = createRes.body.data;
    expect(student.admissionNo).toMatch(/^STU-2026-\d{4}$/);
    expect(student.fullName).toBe('Meera Iyer');

    // House cannot be deleted while active student belongs to it
    expect((await agent.delete(`/api/student-houses/${houseId}`)).status).toBe(409);

    const listRes = await agent.get(`/api/students?q=Meera&studentHouseId=${houseId}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].houseName).toBe('Sapphire House');

    const updRes = await agent.patch(`/api/students/${student.id}`).send({ lastName: 'Subramanian', studentHouseId: null });
    expect(updRes.status).toBe(200);
    expect(updRes.body.data.fullName).toBe('Meera Subramanian');

    // Status change to transferred_out requires leftOn
    const badStatus = await agent.patch(`/api/students/${student.id}/status`).send({ status: 'transferred_out' });
    expect(badStatus.status).toBe(400);

    const okStatus = await agent.patch(`/api/students/${student.id}/status`).send({
      status: 'transferred_out',
      leftOn: '2027-03-31',
      leftReason: 'Family relocated',
    });
    expect(okStatus.status).toBe(200);
    expect(okStatus.body.data.status).toBe('transferred_out');
    expect(okStatus.body.data.leftOn).toBe('2027-03-31');

    // Now house has 0 students and can be deleted
    expect((await agent.delete(`/api/student-houses/${houseId}`)).status).toBe(204);
    expect((await agent.delete(`/api/students/${student.id}`)).status).toBe(204);
    expect((await agent.get(`/api/students/${student.id}`)).status).toBe(404);
  });

  it('supports many-to-many student-guardian links, primary guardian switching and pickup authorization', async () => {
    const { agent } = await setupSchool('stu-guard');

    const s1 = (
      await agent.post('/api/students').send({
        admissionNo: 'STU-SIB-01',
        firstName: 'Ananya',
        lastName: 'Rao',
        dob: '2015-03-10',
        admittedOn: '2026-06-01',
      })
    ).body.data;

    const s2 = (
      await agent.post('/api/students').send({
        admissionNo: 'STU-SIB-02',
        firstName: 'Vikram',
        lastName: 'Rao',
        dob: '2017-07-22',
        admittedOn: '2026-06-01',
      })
    ).body.data;

    // Create Guardian 1 (Father) standalone and link to both siblings
    const gFather = (
      await agent.post('/api/guardians').send({
        fullName: 'Suresh Rao',
        relation: 'father',
        phone: '9876000001',
        occupation: 'Doctor',
        annualIncome: 1200000,
        isEmergencyContact: true,
      })
    ).body.data;

    const link1 = await agent.post(`/api/students/${s1.id}/guardians`).send({
      guardianId: gFather.id,
      isPrimary: true,
      canPickUp: true,
    });
    expect(link1.status).toBe(201);

    const link2 = await agent.post(`/api/students/${s2.id}/guardians`).send({
      guardianId: gFather.id,
      isPrimary: true,
      canPickUp: false,
    });
    expect(link2.status).toBe(201);

    // One guardian -> multiple students
    const getFather = await agent.get(`/api/guardians/${gFather.id}`);
    expect(getFather.status).toBe(200);
    expect(getFather.body.data.students).toHaveLength(2);

    // Create-and-link Mother for s1 as primary -> must unset Father's isPrimary and update students.primaryGuardianId
    const linkMother = await agent.post(`/api/students/${s1.id}/guardians`).send({
      guardian: {
        fullName: 'Lakshmi Rao',
        relation: 'mother',
        phone: '9876000002',
        isEmergencyContact: true,
      },
      isPrimary: true,
      canPickUp: true,
    });
    expect(linkMother.status).toBe(201);
    expect(linkMother.body.data).toHaveLength(2);
    const motherRow = linkMother.body.data.find((g: { fullName: string }) => g.fullName === 'Lakshmi Rao');
    const fatherRow = linkMother.body.data.find((g: { id: string }) => g.id === gFather.id);
    expect(motherRow.isPrimary).toBe(true);
    expect(fatherRow.isPrimary).toBe(false);

    const s1Details = await agent.get(`/api/students/${s1.id}`);
    expect(s1Details.body.data.primaryGuardianId).toBe(motherRow.id);

    // Toggle canPickUp and switch primary back via PATCH
    const patchLink = await agent.patch(`/api/students/${s1.id}/guardians/${gFather.id}`).send({
      isPrimary: true,
      canPickUp: false,
    });
    expect(patchLink.status).toBe(200);
    const updatedFather = patchLink.body.data.find((g: { id: string }) => g.id === gFather.id);
    const updatedMother = patchLink.body.data.find((g: { id: string }) => g.id === motherRow.id);
    expect(updatedFather.isPrimary).toBe(true);
    expect(updatedFather.canPickUp).toBe(false);
    expect(updatedMother.isPrimary).toBe(false);

    // Cannot delete guardian while linked to students
    expect((await agent.delete(`/api/guardians/${motherRow.id}`)).status).toBe(409);

    // Unlink mother from s1, then delete mother guardian
    expect((await agent.delete(`/api/students/${s1.id}/guardians/${motherRow.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/guardians/${motherRow.id}`)).status).toBe(204);
  });

  it('manages student documents and verification workflow', async () => {
    const { agent } = await setupSchool('stu-docs');

    const stu = (
      await agent.post('/api/students').send({
        firstName: 'Neha',
        lastName: 'Kulkarni',
        dob: '2016-05-05',
        admittedOn: '2026-06-01',
      })
    ).body.data;

    const addDoc = await agent.post(`/api/students/${stu.id}/documents`).send({
      documentType: 'birth_certificate',
      fileId: '1',
      documentNo: 'BC-2016-889',
      issuedOn: '2016-05-20',
      expiresOn: '2030-05-20',
    });
    expect(addDoc.status).toBe(201);
    const docId = addDoc.body.data.id as string;
    expect(addDoc.body.data.verifiedStatus).toBe('pending');

    const verifyRes = await agent.patch(`/api/students/${stu.id}/documents/${docId}/verify`).send({
      verifiedStatus: 'verified',
      remarks: 'Checked against original',
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.verifiedStatus).toBe('verified');
    expect(verifyRes.body.data.verifiedBy).toBeTruthy();
    expect(verifyRes.body.data.verifiedAt).toBeTruthy();

    const getStu = await agent.get(`/api/students/${stu.id}`);
    expect(getStu.body.data.documents).toHaveLength(1);
    expect(getStu.body.data.documents[0].verifiedStatus).toBe('verified');

    expect((await agent.delete(`/api/students/${stu.id}/documents/${docId}`)).status).toBe(204);
    expect((await agent.get(`/api/students/${stu.id}/documents`)).body.data).toHaveLength(0);
  });

  it('enforces permissions and cross-organization isolation', async () => {
    const schoolA = await setupSchool('stu-iso-a');
    const schoolB = await setupSchool('stu-iso-b');

    const stuA = (
      await schoolA.agent.post('/api/students').send({
        firstName: 'Tara',
        lastName: 'Singh',
        dob: '2015-11-11',
        admittedOn: '2026-06-01',
      })
    ).body.data;
    const guardA = (
      await schoolA.agent.post('/api/guardians').send({
        fullName: 'Manoj Singh',
        relation: 'father',
        phone: '9222222222',
      })
    ).body.data;

    // Cross-org checks
    expect((await schoolB.agent.get(`/api/students/${stuA.id}`)).status).toBe(404);
    expect((await schoolB.agent.patch(`/api/students/${stuA.id}`).send({ firstName: 'Hack' })).status).toBe(404);
    expect((await schoolB.agent.get(`/api/guardians/${guardA.id}`)).status).toBe(404);

    const stuB = (
      await schoolB.agent.post('/api/students').send({
        firstName: 'Dev',
        lastName: 'Patel',
        dob: '2015-12-12',
        admittedOn: '2026-06-01',
      })
    ).body.data;
    expect(
      (
        await schoolB.agent.post(`/api/students/${stuB.id}/guardians`).send({
          guardianId: guardA.id,
          isPrimary: true,
          canPickUp: true,
        })
      ).status,
    ).toBe(404);

    // Permission checks: teacher can view students, cannot create/edit/delete
    const teacherEmail = uniqueEmail('stu-teacher');
    await schoolA.agent.post('/api/members').send({
      email: teacherEmail,
      fullName: 'Teacher Two',
      password: VALID_PASSWORD,
      roles: ['teacher'],
    });
    const { agent: tAgent } = await signupAndLogin('stu-t-login');
    const tLogin = await tAgent.post('/api/auth/login').send({
      email: teacherEmail,
      password: VALID_PASSWORD,
      organization: schoolA.slug,
    });
    const tToken = tLogin.body.data.accessToken as string;

    expect((await tAgent.get('/api/students').set('Authorization', `Bearer ${tToken}`)).status).toBe(200);
    expect(
      (
        await tAgent
          .post('/api/students')
          .set('Authorization', `Bearer ${tToken}`)
          .send({ firstName: 'No', lastName: 'Perm', dob: '2016-01-01' })
      ).status,
    ).toBe(403);
    expect((await tAgent.delete(`/api/students/${stuA.id}`).set('Authorization', `Bearer ${tToken}`)).status).toBe(403);
  });
});
