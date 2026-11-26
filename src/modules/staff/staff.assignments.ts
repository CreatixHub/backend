import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { classes, sectionTeachers, sections, subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ClassSubject = { classId: bigint; subjectId: bigint };

// Saves "this teacher takes <subject> in <class>". A class is stored per section, so the teacher is
// assigned to every section of the class. The caller resolves the academic year for the tenant before the transaction.
export async function saveAssignments(
  tx: Tx,
  tenantId: bigint,
  teacherId: bigint,
  academicYearId: bigint,
  items: ClassSubject[],
): Promise<void> {
  // same class + subject listed twice -> once
  const unique = new Map<string, ClassSubject>();
  for (const i of items) unique.set(`${i.classId}:${i.subjectId}`, i);
  const pairs = [...unique.values()];
  if (pairs.length === 0) return;

  const classIds = [...new Set(pairs.map((p) => p.classId))];
  const subjectIds = [...new Set(pairs.map((p) => p.subjectId))];

  const classRows = await tx
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(and(eq(classes.tenantId, tenantId), inArray(classes.id, classIds)));
  if (classRows.length !== classIds.length) throw new HttpError(400, 'One of the classes was not found in this school');
  const className = new Map(classRows.map((c) => [c.id, c.name]));

  const subjectRows = await tx
    .select({ id: subjects.id, name: subjects.name })
    .from(subjects)
    .where(and(eq(subjects.tenantId, tenantId), isNull(subjects.deletedAt), inArray(subjects.id, subjectIds)));
  if (subjectRows.length !== subjectIds.length) throw new HttpError(400, 'One of the subjects was not found in this school');
  const subjectName = new Map(subjectRows.map((s) => [s.id, s.name]));

  const sectionRows = await tx
    .select({ id: sections.id, classId: sections.classId, name: sections.name })
    .from(sections)
    .where(and(eq(sections.tenantId, tenantId), isNull(sections.deletedAt), inArray(sections.classId, classIds)));

  const sectionsOf = new Map<bigint, { id: bigint; name: string }[]>();
  for (const s of sectionRows) {
    const list = sectionsOf.get(s.classId) ?? [];
    list.push({ id: s.id, name: s.name });
    sectionsOf.set(s.classId, list);
  }
  for (const id of classIds) {
    if (!sectionsOf.get(id)?.length) {
      throw new HttpError(400, `${className.get(id)} has no sections yet. Add a section to that class first.`);
    }
  }

  // one row per (section, subject)
  const wanted: { sectionId: bigint; subjectId: bigint; label: string }[] = [];
  for (const p of pairs) {
    for (const s of sectionsOf.get(p.classId)!) {
      wanted.push({
        sectionId: s.id,
        subjectId: p.subjectId,
        label: `${className.get(p.classId)} - ${s.name} already has a teacher for ${subjectName.get(p.subjectId)}`,
      });
    }
  }

  // a section can have only one teacher per subject per year
  const existing = await tx
    .select({ sectionId: sectionTeachers.sectionId, subjectId: sectionTeachers.subjectId })
    .from(sectionTeachers)
    .where(
      and(
        eq(sectionTeachers.tenantId, tenantId),
        eq(sectionTeachers.academicYearId, academicYearId),
        inArray(sectionTeachers.sectionId, wanted.map((w) => w.sectionId)),
        inArray(sectionTeachers.subjectId, subjectIds),
      ),
    );
  const taken = new Set(existing.map((e) => `${e.sectionId}:${e.subjectId}`));
  const clash = wanted.find((w) => taken.has(`${w.sectionId}:${w.subjectId}`));
  if (clash) throw new HttpError(409, `${clash.label}. Pick a different class or subject.`);

  await tx.insert(sectionTeachers).values(
    wanted.map((w) => ({
      tenantId,
      sectionId: w.sectionId,
      subjectId: w.subjectId,
      academicYearId,
      teacherId,
    })),
  );
}