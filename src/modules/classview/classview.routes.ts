import { Router } from 'express';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, students } from '../../db/schema';
import { ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';

export const classViewRouter = Router();
classViewRouter.use(requirePermission('admissions.view'));

// All classes with how many students / applicants each has
classViewRouter.get('/classes', async (req, res) => {
  const tenant = currentTenant(req);
  const rows = await db
    .select({
      id: classes.id,
      name: classes.name,
      total: sql<number>`count(${admissions.id})::int`,
      students: sql<number>`count(${admissions.studentId})::int`,
    })
    .from(classes)
    .leftJoin(
      admissions,
      and(eq(admissions.classId, classes.id), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)),
    )
    .where(eq(classes.tenantId, tenant.id))
    .groupBy(classes.id, classes.name)
    .orderBy(asc(classes.id));
  ok(res, { classes: rows.map((r) => ({ id: String(r.id), name: r.name, total: r.total, students: r.students })) });
});

// Students and applicants of the chosen classes: /class-view?classIds=1,2
classViewRouter.get('/', async (req, res) => {
  const tenant = currentTenant(req);
  const ids = String(req.query.classIds ?? '')
    .split(',')
    .filter((s) => /^\d+$/.test(s))
    .map((s) => BigInt(s));
  if (ids.length === 0) return ok(res, { rows: [] });
  const rows = await db
    .select({
      admissionId: admissions.id,
      applicationNo: admissions.applicationNo,
      status: admissions.status,
      firstName: admissions.firstName,
      lastName: admissions.lastName,
      guardianName: admissions.guardianName,
      guardianPhone: admissions.guardianPhone,
      classId: admissions.classId,
      className: classes.name,
      studentId: students.id,
      fullName: students.fullName,
      admissionNo: students.admissionNo,
      rollNo: students.rollNo,
      studentStatus: students.status,
    })
    .from(admissions)
    .innerJoin(classes, eq(classes.id, admissions.classId))
    .leftJoin(students, and(eq(students.id, admissions.studentId), isNull(students.deletedAt)))
    .where(and(eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt), inArray(admissions.classId, ids)))
    .orderBy(asc(classes.id), asc(admissions.id));
  ok(res, {
    rows: rows.map((r) => ({
      admissionId: String(r.admissionId),
      classId: String(r.classId),
      className: r.className,
      kind: r.studentId ? 'student' : 'applicant',
      name: r.fullName || [r.firstName, r.lastName].filter(Boolean).join(' '),
      admissionNo: r.admissionNo ?? null,
      rollNo: r.rollNo == null ? null : String(r.rollNo),
      status: String(r.studentStatus ?? r.status ?? ''),
      applicationNo: r.applicationNo ?? null,
      guardianName: r.guardianName ?? null,
      guardianPhone: r.guardianPhone ?? null,
    })),
  });
});