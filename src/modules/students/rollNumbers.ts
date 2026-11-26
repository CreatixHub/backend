import { Router } from 'express';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { admissions, classes, students } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { ok } from '../../lib/respond';
import type { TenantContext } from '../../lib/tenant';
import { currentTenant } from '../../middleware/authenticate';

// ROLL NUMBERS: the admin types a prefix (e.g. B26); each student gets  prefix + class number + 3-digit serial,
// e.g. B26 + 1 + 001 = B261001. The serial follows A-Z order of the student's name, class by class.
// Active students only. A student's class comes from their admission record. Administrators only.

export const rollNumbersRouter = Router();

function requireAdmin(tenant: TenantContext) {
  if (!(tenant.permissions.has('*') || tenant.roles.includes('admin'))) {
    throw new HttpError(403, 'Only an administrator can manage roll numbers');
  }
}

const prefixSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,10}$/, 'The prefix must be 1 to 10 letters or digits, e.g. B26')
  .transform((s) => s.toUpperCase());

const displayName = sql<string>`coalesce(nullif(trim(${students.fullName}), ''), trim(${students.firstName} || ' ' || ${students.lastName}))`;

async function loadClass(tenantId: bigint, classId: bigint) {
  const [c] = await db
    .select({ id: classes.id, name: classes.name, gradeLevel: classes.gradeLevel })
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId), isNull(classes.deletedAt)))
    .limit(1);
  if (!c) throw new HttpError(404, 'Class not found');
  return c;
}

async function classStudents(tenantId: bigint, classId: bigint) {
  return db
    .select({ id: students.id, name: displayName, admissionNo: students.admissionNo, rollNo: students.rollNo })
    .from(students)
    .innerJoin(admissions, eq(admissions.studentId, students.id))
    .where(
      and(
        eq(students.tenantId, tenantId),
        eq(admissions.tenantId, tenantId),
        eq(admissions.classId, classId),
        eq(students.status, 'active'),
        isNull(students.deletedAt),
        isNull(admissions.deletedAt),
      ),
    )
    .orderBy(asc(sql`lower(${displayName})`), asc(students.id));
}

const makeRoll = (prefix: string, grade: number, index: number) =>
  `${prefix}${grade}${String(index + 1).padStart(3, '0')}`;

// GET /api/roll-numbers/classes
rollNumbersRouter.get('/classes', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const rows = await db
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(and(eq(classes.tenantId, tenant.id), isNull(classes.deletedAt)))
    .orderBy(asc(classes.gradeLevel), asc(classes.name));
  ok(res, rows.map((r) => ({ id: String(r.id), name: r.name })));
});

// GET /api/roll-numbers/preview?classId=&prefix=  -> the class sorted A-Z with the roll number each student WOULD get
rollNumbersRouter.get('/preview', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const q = z.object({ classId: z.coerce.bigint().positive(), prefix: prefixSchema }).parse(req.query);
  const cls = await loadClass(tenant.id, q.classId);
  const rows = await classStudents(tenant.id, q.classId);
  ok(
    res,
    rows.map((r, i) => ({
      id: String(r.id),
      name: r.name,
      admissionNo: r.admissionNo,
      currentRoll: r.rollNo,
      newRoll: makeRoll(q.prefix, cls.gradeLevel, i),
    })),
  );
});

// POST /api/roll-numbers/generate { classId, prefix }  -> assigns the roll numbers (replaces this class's)
rollNumbersRouter.post('/generate', async (req, res) => {
  const tenant = currentTenant(req);
  requireAdmin(tenant);
  const q = z.object({ classId: z.coerce.bigint().positive(), prefix: prefixSchema }).strict().parse(req.body);
  const cls = await loadClass(tenant.id, q.classId);
  const rows = await classStudents(tenant.id, q.classId);
  if (rows.length === 0) throw new HttpError(400, 'There are no active students in this class');
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      await tx
        .update(students)
        .set({ rollNo: makeRoll(q.prefix, cls.gradeLevel, i) })
        .where(and(eq(students.id, rows[i].id), eq(students.tenantId, tenant.id)));
    }
  });
  ok(res, { count: rows.length });
});