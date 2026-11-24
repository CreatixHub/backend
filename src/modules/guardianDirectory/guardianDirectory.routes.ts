import { Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, studentGuardians, students } from '../../db/schema';
import { ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { listGuardiansSchema } from '../students/students.schemas';
import * as studentsSvc from '../students/students.service';

// GET /api/guardian-directory
// Same list (and same "who may see whom" rules) as GET /api/guardians, but every guardian also says
// WHICH student they belong to and in which class, so the mobile list reads like:
//
//   Suresh Kumar
//   Student: Arun Kumar - Class V
//   Relation to student: Father
//   Admission No: ADM-1001
//   Phone: 9876543210
export const guardianDirectoryRouter = Router();

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

guardianDirectoryRouter.get('/', requirePermission('students.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const actor = currentUser(req);
  const q = listGuardiansSchema.parse({ ...req.query, limit: req.query.limit ?? '100' });

  // Existing rules decide which guardians this person may see.
  const result = await studentsSvc.listGuardians(tenant, actor, q);
  const ids = result.rows.map((r) => BigInt(String((r as { id: unknown }).id)));

  const links = ids.length
    ? await db
        .select({
          guardianId: studentGuardians.guardianId,
          studentName: students.fullName,
          admissionNo: students.admissionNo,
          className: classes.name,
        })
        .from(studentGuardians)
        .innerJoin(students, eq(studentGuardians.studentId, students.id))
        .leftJoin(admissions, eq(students.admissionId, admissions.id))
        .leftJoin(classes, eq(admissions.classId, classes.id))
        .where(
          and(
            eq(studentGuardians.tenantId, tenant.id),
            inArray(studentGuardians.guardianId, ids),
            isNull(students.deletedAt),
          ),
        )
        .orderBy(asc(students.fullName))
    : [];

  const byGuardian = new Map<string, typeof links>();
  for (const l of links) {
    const k = String(l.guardianId);
    byGuardian.set(k, [...(byGuardian.get(k) ?? []), l]);
  }

  const rows = result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    const mine = byGuardian.get(String(row.id)) ?? [];
    const { fullName, relation, phone, ...rest } = row;
    return {
      // key order = the order the mobile list shows (first four lines after the name)
      fullName,
      student: mine.length
        ? mine.map((s) => (s.className ? `${s.studentName} - ${s.className}` : String(s.studentName))).join(', ')
        : 'Not linked to a student',
      relationToStudent: cap(String(relation ?? '')),
      admissionNo: mine.map((s) => s.admissionNo).join(', ') || null,
      phone,
      ...rest,
    };
  });

  ok(res, rows, result.meta);
});
