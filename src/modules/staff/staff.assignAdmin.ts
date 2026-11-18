import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { classes, classSubjects, sectionTeachers, sections, staff, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import { saveAssignments } from './staff.assignments';

const id = z.coerce.bigint().positive();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// academicYearId + the classes and subjects to add (every section of each class is assigned).
export const addAssignmentsSchema = z
  .object({
    academicYearId: id,
    assignments: z.array(z.object({ classId: id, subjectId: id }).strict()).min(1).max(40),
  })
  .strict();

export type AddAssignmentsInput = z.infer<typeof addAssignmentsSchema>;

const DEFAULT_SECTION_NAME = 'A';
const DEFAULT_SECTION_CAPACITY = 40;

// Marks setup for a subject that is registered for a class automatically (change it later in Classes).
const DEFAULT_EXAM_MARKS = '80';
const DEFAULT_INTERNAL_MARKS = '20';
const DEFAULT_PASS_MARKS = '35';

/**
 * A teacher is stored per section, so every class needs at least one.
 * A class with no section gets a default section "A" (capacity 40; change it later in Classes).
 */
export async function ensureDefaultSections(tx: Tx, tenantId: bigint, classIds: bigint[]): Promise<void> {
  const unique = [...new Set(classIds.map((c) => c.toString()))].map((c) => BigInt(c));
  for (const classId of unique) {
    const [cls] = await tx
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId)))
      .limit(1);
    if (!cls) continue; // an unknown class is reported by saveAssignments

    const [hasSection] = await tx
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.tenantId, tenantId), eq(sections.classId, classId), isNull(sections.deletedAt)))
      .limit(1);
    if (hasSection) continue;

    await tx.insert(sections).values({
      tenantId,
      classId,
      name: DEFAULT_SECTION_NAME,
      capacity: DEFAULT_SECTION_CAPACITY,
    });
  }
}

/**
 * The timetable only accepts a subject that is registered for the class (class_subjects).
 * Every class + subject given to a teacher is registered here if it is not already.
 */
export async function ensureClassSubjects(
  tx: Tx,
  tenantId: bigint,
  pairs: { classId: bigint; subjectId: bigint }[],
): Promise<void> {
  if (pairs.length === 0) return;

  // only real classes and subjects of this school (unknown ids are reported by saveAssignments)
  const classIds = [...new Set(pairs.map((p) => p.classId.toString()))].map((c) => BigInt(c));
  const subjectIds = [...new Set(pairs.map((p) => p.subjectId.toString()))].map((s) => BigInt(s));

  const [knownClasses, knownSubjects] = await Promise.all([
    tx
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.tenantId, tenantId), inArray(classes.id, classIds))),
    tx
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, tenantId), inArray(subjects.id, subjectIds))),
  ]);
  const classOk = new Set(knownClasses.map((c) => c.id.toString()));
  const subjectOk = new Set(knownSubjects.map((s) => s.id.toString()));

  const seen = new Set<string>();
  const rows: (typeof classSubjects.$inferInsert)[] = [];
  for (const p of pairs) {
    const key = `${p.classId}:${p.subjectId}`;
    if (seen.has(key) || !classOk.has(p.classId.toString()) || !subjectOk.has(p.subjectId.toString())) continue;
    seen.add(key);
    rows.push({
      tenantId,
      classId: p.classId,
      subjectId: p.subjectId,
      examMarks: DEFAULT_EXAM_MARKS,
      internalMarks: DEFAULT_INTERNAL_MARKS,
      passMarks: DEFAULT_PASS_MARKS,
    });
  }
  if (rows.length === 0) return;

  // already registered pairs are left exactly as they are
  await tx.insert(classSubjects).values(rows).onConflictDoNothing();
}

async function assertTeacher(tenantId: bigint, teacherId: bigint): Promise<void> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, teacherId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Staff member not found');
}

/** Adds class + subject pairs to an existing teacher (all-or-nothing). */
export async function addAssignments(
  tenant: TenantContext,
  teacherId: bigint,
  input: AddAssignmentsInput,
): Promise<void> {
  await assertTeacher(tenant.id, teacherId);
  await db.transaction(async (tx) => {
    await ensureDefaultSections(
      tx,
      tenant.id,
      input.assignments.map((a) => a.classId),
    );
    await ensureClassSubjects(tx, tenant.id, input.assignments);
    await saveAssignments(tx, tenant.id, teacherId, input.academicYearId, input.assignments);
  });
}

/** Removes one subject of one class (every section of that class) from the teacher. */
export async function removeAssignment(
  tenant: TenantContext,
  teacherId: bigint,
  classId: bigint,
  subjectId: bigint,
): Promise<void> {
  await assertTeacher(tenant.id, teacherId);
  await db.delete(sectionTeachers).where(
    and(
      eq(sectionTeachers.tenantId, tenant.id),
      eq(sectionTeachers.teacherId, teacherId),
      eq(sectionTeachers.subjectId, subjectId),
      inArray(
        sectionTeachers.sectionId,
        db.select({ id: sections.id }).from(sections).where(eq(sections.classId, classId)),
      ),
    ),
  );
}