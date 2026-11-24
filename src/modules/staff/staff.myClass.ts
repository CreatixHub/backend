import { Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, classTeachers, staff, students } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import type { AuthUser } from '../../middleware/authenticate';

// "My Class": the class(es) the signed-in teacher is CLASS TEACHER of (set in the admin app under
// Class Teachers), each with only that class's active students.
// GET /api/staff/me/class - no permission needed; tied to the teacher's own login.

async function myStaffId(tenant: TenantContext, actor: AuthUser): Promise<bigint> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.userId, actor.id), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'No staff record is linked to this login');
  return row.id;
}

export async function getMyClass(tenant: TenantContext, actor: AuthUser) {
  const teacherId = await myStaffId(tenant, actor);

  const myClasses = await db
    .select({ id: classes.id, name: classes.name, code: classes.code })
    .from(classTeachers)
    .innerJoin(classes, eq(classTeachers.classId, classes.id))
    .where(and(eq(classTeachers.tenantId, tenant.id), eq(classTeachers.teacherId, teacherId), isNull(classes.deletedAt)))
    .orderBy(asc(classes.gradeLevel), asc(classes.name));

  if (myClasses.length === 0) {
    return { message: 'You have not been assigned a class yet.', classes: [] as unknown[] };
  }

  const classIds = myClasses.map((c) => c.id);
  const rows = await db
    .select({
      classId: admissions.classId,
      id: students.id,
      admissionNo: students.admissionNo,
      fullName: students.fullName,
      firstName: students.firstName,
      lastName: students.lastName,
      gender: students.gender,
      dob: students.dob,
      status: students.status,
      photoFileId: students.photoFileId,
      fatherName: students.fatherName,
      fatherPhone: students.fatherPhone,
      motherName: students.motherName,
      motherPhone: students.motherPhone,
    })
    .from(admissions)
    .innerJoin(students, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(admissions.tenantId, tenant.id),
        inArray(admissions.classId, classIds),
        isNull(admissions.deletedAt),
        eq(students.tenantId, tenant.id),
        isNull(students.deletedAt),
        eq(students.status, 'active'),
      ),
    )
    .orderBy(asc(students.fullName), asc(students.firstName));

  return {
    message: '',
    classes: myClasses.map((c) => {
      const list = rows
        .filter((r) => r.classId === c.id)
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i) // one row per student
        .map(({ classId: _classId, ...student }) => student);
      return { ...c, studentCount: list.length, students: list };
    }),
  };
}

export const myClassRouter = Router();

myClassRouter.get('/', async (req, res) => {
  ok(res, await getMyClass(currentTenant(req), currentUser(req)));
});
