import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { admissions, classes, staff, students } from '../../db/schema';
import type { TenantContext } from '../../lib/tenant';

type GenderKey = 'male' | 'female' | 'other' | 'unknown';
interface GenderCount {
  male: number;
  female: number;
  other: number;
  unknown: number;
}

const emptyGender = (): GenderCount => ({ male: 0, female: 0, other: 0, unknown: 0 });

function normGender(value: string | null): GenderKey {
  const g = (value ?? '').trim().toLowerCase();
  if (['male', 'm', 'boy', 'man'].includes(g)) return 'male';
  if (['female', 'f', 'girl', 'woman'].includes(g)) return 'female';
  if (g === '' || g === 'unknown') return 'unknown';
  return 'other';
}

// gender is free text in the database, so lower-case it and let normGender() decide
const staffGender = sql<string>`lower(trim(coalesce(${staff.gender}, '')))`;
const studentGender = sql<string>`lower(trim(coalesce(${students.gender}, '')))`;

interface ClassStrength extends GenderCount {
  classId: string;
  name: string;
  total: number;
}

const joinName = (full: string | null, first: string | null, last: string | null) =>
  (full && full.trim()) || [first, last].filter(Boolean).join(' ').trim() || '—';

export async function schoolStrength(tenant: TenantContext) {
  const [staffRows, classRows, studentRows, facultyRows, studentListRows] = await Promise.all([
    db
      .select({
        staffType: staff.staffType,
        employmentType: staff.employmentType,
        status: staff.status,
        gender: staffGender,
        total: count(),
      })
      .from(staff)
      .where(and(eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
      .groupBy(staff.staffType, staff.employmentType, staff.status, staffGender),

    db
      .select({ id: classes.id, name: classes.name })
      .from(classes)
      .where(and(eq(classes.tenantId, tenant.id), isNull(classes.deletedAt)))
      .orderBy(asc(classes.gradeLevel), asc(classes.name)),

    // a student's class comes from the admission they were admitted through
    db
      .select({
        classId: classes.id,
        status: students.status,
        gender: studentGender,
        total: count(),
      })
      .from(students)
      .leftJoin(admissions, and(eq(admissions.studentId, students.id), isNull(admissions.deletedAt)))
      .leftJoin(classes, eq(classes.id, admissions.classId))
      .where(and(eq(students.tenantId, tenant.id), isNull(students.deletedAt)))
      .groupBy(classes.id, students.status, studentGender),

    // faculty names: everyone who has not left
    db
      .select({
        id: staff.id,
        employeeNo: staff.employeeNo,
        fullName: staff.fullName,
        firstName: staff.firstName,
        lastName: staff.lastName,
        staffType: staff.staffType,
        employmentType: staff.employmentType,
        gender: staff.gender,
        status: staff.status,
      })
      .from(staff)
      .where(and(eq(staff.tenantId, tenant.id), isNull(staff.deletedAt), ne(staff.status, 'left')))
      .orderBy(asc(staff.staffType), asc(staff.fullName), asc(staff.firstName)),

    // student names: active students, with their class
    db
      .select({
        id: students.id,
        admissionNo: students.admissionNo,
        fullName: students.fullName,
        firstName: students.firstName,
        lastName: students.lastName,
        gender: students.gender,
        classId: classes.id,
        className: classes.name,
      })
      .from(students)
      .leftJoin(admissions, and(eq(admissions.studentId, students.id), isNull(admissions.deletedAt)))
      .leftJoin(classes, eq(classes.id, admissions.classId))
      .where(and(eq(students.tenantId, tenant.id), isNull(students.deletedAt), eq(students.status, 'active')))
      .orderBy(asc(classes.gradeLevel), asc(students.fullName), asc(students.firstName)),
  ]);

  // ---- faculty counts: everyone who has not left the school
  let teaching = 0;
  let nonTeaching = 0;
  const facultyGender = emptyGender();
  const teachingGender = emptyGender();
  const nonTeachingGender = emptyGender();
  const byEmploymentType: Record<string, number> = {};
  const facultyStatus: Record<string, number> = {};

  for (const r of staffRows) {
    facultyStatus[r.status] = (facultyStatus[r.status] ?? 0) + r.total;
    if (r.status === 'left') continue;
    const g = normGender(r.gender);
    facultyGender[g] += r.total;
    byEmploymentType[r.employmentType] = (byEmploymentType[r.employmentType] ?? 0) + r.total;
    if (r.staffType === 'teaching') {
      teaching += r.total;
      teachingGender[g] += r.total;
    } else {
      nonTeaching += r.total;
      nonTeachingGender[g] += r.total;
    }
  }

  // ---- student counts: active students only
  const classMap = new Map<string, ClassStrength>();
  for (const c of classRows) {
    classMap.set(String(c.id), { classId: String(c.id), name: c.name, total: 0, ...emptyGender() });
  }
  const unassigned = { ...emptyGender(), total: 0 };
  const studentGenderTotals = emptyGender();
  const studentStatus: Record<string, number> = {};
  let studentTotal = 0;

  for (const r of studentRows) {
    studentStatus[r.status] = (studentStatus[r.status] ?? 0) + r.total;
    if (r.status !== 'active') continue;
    const g = normGender(r.gender);
    studentGenderTotals[g] += r.total;
    studentTotal += r.total;

    const row = r.classId === null ? undefined : classMap.get(String(r.classId));
    if (row) {
      row[g] += r.total;
      row.total += r.total;
    } else {
      unassigned[g] += r.total;
      unassigned.total += r.total;
    }
  }

  // ---- name lists
  const facultyList = facultyRows.map((r) => ({
    id: String(r.id),
    employeeNo: r.employeeNo,
    name: joinName(r.fullName, r.firstName, r.lastName),
    staffType: r.staffType,
    employmentType: r.employmentType,
    gender: normGender(r.gender),
    status: r.status,
  }));

  const studentList = studentListRows.map((r) => ({
    id: String(r.id),
    admissionNo: r.admissionNo,
    name: joinName(r.fullName, r.firstName, r.lastName),
    gender: normGender(r.gender),
    classId: r.classId === null ? null : String(r.classId),
    className: r.className ?? null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    faculty: {
      total: teaching + nonTeaching,
      teaching,
      nonTeaching,
      byGender: facultyGender,
      teachingByGender: teachingGender,
      nonTeachingByGender: nonTeachingGender,
      byEmploymentType,
      byStatus: facultyStatus,
      list: facultyList,
    },
    students: {
      total: studentTotal,
      byGender: studentGenderTotals,
      byStatus: studentStatus,
      classes: [...classMap.values()],
      unassigned,
      list: studentList,
    },
  };
}