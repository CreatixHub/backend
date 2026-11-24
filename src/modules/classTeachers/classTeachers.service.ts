import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { classes, classTeachers, staff } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  AssignClassTeacherInput,
  ListClassTeachersInput,
  UpdateClassTeacherInput,
} from './classTeachers.schemas';

// RULES (same as the other modules): every query has tenantId = tenant.id.
// A class has at most ONE class teacher. A teacher may lead more than one class.

interface Page {
  rows: unknown[];
  meta: { page: number; limit: number; total: number; pages: number };
}
const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const baseQuery = () =>
  db
    .select({
      id: classTeachers.id,
      classId: classTeachers.classId,
      className: classes.name,
      classCode: classes.code,
      teacherId: classTeachers.teacherId,
      teacherName: staff.fullName,
      createdAt: classTeachers.createdAt,
      updatedAt: classTeachers.updatedAt,
    })
    .from(classTeachers)
    .innerJoin(classes, eq(classTeachers.classId, classes.id))
    .innerJoin(staff, eq(classTeachers.teacherId, staff.id));

async function loadOne(tenantId: bigint, id: bigint) {
  const [row] = await baseQuery()
    .where(and(eq(classTeachers.id, id), eq(classTeachers.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Class teacher assignment not found');
  return row;
}

async function assertClass(tenantId: bigint, classId: bigint) {
  const [row] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId), isNull(classes.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Class not found in this school');
}

// The teacher must be an ACTIVE, TEACHING staff member of this school.
async function assertTeacher(tenantId: bigint, teacherId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.id, teacherId),
        eq(staff.tenantId, tenantId),
        isNull(staff.deletedAt),
        eq(staff.staffType, 'teaching'),
        eq(staff.status, 'active'),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(400, 'Teacher must be an active teaching staff member of this school');
}

export async function listClassTeachers(tenant: TenantContext, q: ListClassTeachersInput): Promise<Page> {
  const where = and(
    eq(classTeachers.tenantId, tenant.id),
    q.classId ? eq(classTeachers.classId, q.classId) : undefined,
    q.teacherId ? eq(classTeachers.teacherId, q.teacherId) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    baseQuery()
      .where(where)
      .orderBy(asc(classes.gradeLevel), asc(classes.name))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(classTeachers).where(where),
  ]);

  return { rows, meta: pageMeta(q.page, q.limit, total) };
}

export async function getClassTeacher(tenant: TenantContext, id: bigint): Promise<unknown> {
  return loadOne(tenant.id, id);
}

// Assign a class teacher to a class. If the class already has one, that teacher is replaced.
export async function assignClassTeacher(
  tenant: TenantContext,
  _actor: AuthUser,
  input: AssignClassTeacherInput,
): Promise<unknown> {
  await assertClass(tenant.id, input.classId);
  await assertTeacher(tenant.id, input.teacherId);

  const [existing] = await db
    .select({ id: classTeachers.id })
    .from(classTeachers)
    .where(and(eq(classTeachers.tenantId, tenant.id), eq(classTeachers.classId, input.classId)))
    .limit(1);

  try {
    if (existing) {
      await db
        .update(classTeachers)
        .set({ teacherId: input.teacherId })
        .where(and(eq(classTeachers.id, existing.id), eq(classTeachers.tenantId, tenant.id)));
      return loadOne(tenant.id, existing.id);
    }
    const [row] = await db
      .insert(classTeachers)
      .values({ tenantId: tenant.id, classId: input.classId, teacherId: input.teacherId })
      .returning({ id: classTeachers.id });
    return loadOne(tenant.id, row.id);
  } catch (e) {
    // two people assigning the same class at the same moment
    if (isUniqueViolation(e)) throw new HttpError(409, 'That class already has a class teacher');
    throw e;
  }
}

export async function updateClassTeacher(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateClassTeacherInput,
): Promise<unknown> {
  await loadOne(tenant.id, id);
  await assertTeacher(tenant.id, input.teacherId);
  await db
    .update(classTeachers)
    .set({ teacherId: input.teacherId })
    .where(and(eq(classTeachers.id, id), eq(classTeachers.tenantId, tenant.id)));
  return loadOne(tenant.id, id);
}

export async function removeClassTeacher(tenant: TenantContext, id: bigint): Promise<void> {
  await loadOne(tenant.id, id);
  await db.delete(classTeachers).where(and(eq(classTeachers.id, id), eq(classTeachers.tenantId, tenant.id)));
}