import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  admissions,
  guardians,
  memberships,
  staff,
  studentDocuments,
  studentGuardians,
  studentHouses,
  students,
  users,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateGuardianInput,
  CreateStudentDocumentInput,
  CreateStudentHouseInput,
  CreateStudentInput,
  LinkStudentGuardianInput,
  ListGuardiansInput,
  ListStudentHousesInput,
  ListStudentsInput,
  UpdateGuardianInput,
  UpdateStudentDocumentInput,
  UpdateStudentGuardianInput,
  UpdateStudentHouseInput,
  UpdateStudentInput,
  UpdateStudentStatusInput,
  VerifyStudentDocumentInput,
} from './students.schemas';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type StudentRow = typeof students.$inferSelect;
type StudentInsert = typeof students.$inferInsert;
type GuardianRow = typeof guardians.$inferSelect;
type GuardianInsert = typeof guardians.$inferInsert;
type HouseRow = typeof studentHouses.$inferSelect;

const HIDDEN = new Set<string>(['tenantId', 'deletedAt', 'deletedBy']);
const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.has(k)));
const joinName = (first: string, last: string) => [first, last].filter(Boolean).join(' ');
const todayStr = () => new Date().toISOString().slice(0, 10);
const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const LEFT_STATUSES = new Set(['alumni', 'transferred_out', 'expelled']);

// ---------------------------------------------------------------- loaders & assertions
async function loadStudent(tenantId: bigint, id: bigint, runner: Tx | typeof db = db): Promise<StudentRow> {
  const [row] = await runner
    .select()
    .from(students)
    .where(and(eq(students.id, id), eq(students.tenantId, tenantId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Student not found');
  return row;
}

async function loadGuardian(tenantId: bigint, id: bigint, runner: Tx | typeof db = db): Promise<GuardianRow> {
  const [row] = await runner
    .select()
    .from(guardians)
    .where(and(eq(guardians.id, id), eq(guardians.tenantId, tenantId), isNull(guardians.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Guardian not found');
  return row;
}

async function loadHouse(tenantId: bigint, id: bigint): Promise<HouseRow> {
  const [row] = await db
    .select()
    .from(studentHouses)
    .where(and(eq(studentHouses.id, id), eq(studentHouses.tenantId, tenantId), isNull(studentHouses.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Student house not found');
  return row;
}

async function assertHouseInTenant(tenantId: bigint, houseId: bigint) {
  const [row] = await db
    .select({ id: studentHouses.id })
    .from(studentHouses)
    .where(and(eq(studentHouses.id, houseId), eq(studentHouses.tenantId, tenantId), isNull(studentHouses.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Student house not found in this school');
}

async function assertStaffInTenant(tenantId: bigint, staffId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Staff member not found in this school');
}

async function assertUserRelation(tenantId: bigint, userId: bigint, selfId?: bigint) {
  const [member] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .limit(1);
  if (!member) throw new HttpError(400, 'That user is not an active member of this school');

  const [linked] = await db
    .select({ id: students.id })
    .from(students)
    .where(
      and(
        eq(students.tenantId, tenantId),
        eq(students.userId, userId),
        isNull(students.deletedAt),
        selfId === undefined ? undefined : ne(students.id, selfId),
      ),
    )
    .limit(1);
  if (linked) throw new HttpError(409, 'That user is already linked to another student');
}

async function assertAdmissionRelation(tenantId: bigint, admissionId: bigint, selfId?: bigint) {
  const [adm] = await db
    .select({ id: admissions.id, studentId: admissions.studentId })
    .from(admissions)
    .where(and(eq(admissions.id, admissionId), eq(admissions.tenantId, tenantId), isNull(admissions.deletedAt)))
    .limit(1);
  if (!adm) throw new HttpError(400, 'Admission not found in this school');
  if (adm.studentId !== null && adm.studentId !== selfId) {
    throw new HttpError(409, 'That admission is already linked to another student');
  }
}

async function nextAdmissionNo(tx: Tx, tenantId: bigint, year: string, offset: number): Promise<string> {
  const prefix = `STU-${year}-`;
  const [r] = await tx
    .select({ max: sql<number | null>`max(substring(${students.admissionNo} from ${prefix.length + 1})::int)` })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), sql`${students.admissionNo} ~ ${'^STU-' + year + '-[0-9]+$'}`));
  return `${prefix}${String(Number(r?.max ?? 0) + 1 + offset).padStart(4, '0')}`;
}

function guardianToColumns(input: Partial<CreateGuardianInput>): Partial<GuardianInsert> {
  const { annualIncome, ...plain } = input;
  const cols: Partial<GuardianInsert> = { ...plain };
  if (annualIncome !== undefined) {
    cols.annualIncome = annualIncome === null ? null : annualIncome.toFixed(2);
  }
  return cols;
}

// ================================================================ STUDENT HOUSES
const HOUSE_NAME_TAKEN = 'A student house with that name already exists in this school';

export async function listStudentHouses(tenant: TenantContext, q: ListStudentHousesInput) {
  const where = and(
    eq(studentHouses.tenantId, tenant.id),
    isNull(studentHouses.deletedAt),
    q.isActive !== undefined ? eq(studentHouses.isActive, q.isActive) : undefined,
  );

  const [rows, counts] = await Promise.all([
    db
      .select({
        ...getTableColumns(studentHouses),
        houseMasterName: staff.fullName,
      })
      .from(studentHouses)
      .leftJoin(staff, eq(studentHouses.houseMasterId, staff.id))
      .where(where)
      .orderBy(asc(studentHouses.name)),
    db
      .select({ studentHouseId: students.studentHouseId, total: count() })
      .from(students)
      .where(and(eq(students.tenantId, tenant.id), isNull(students.deletedAt)))
      .groupBy(students.studentHouseId),
  ]);

  const studentCount = new Map(counts.filter((c) => c.studentHouseId !== null).map((c) => [c.studentHouseId!, c.total]));
  return rows.map((r) => ({ ...toRow(r), studentCount: studentCount.get(r.id) ?? 0 }));
}

export async function getStudentHouse(tenant: TenantContext, id: bigint) {
  const house = await loadHouse(tenant.id, id);
  const [{ total }] = await db
    .select({ total: count() })
    .from(students)
    .where(and(eq(students.tenantId, tenant.id), eq(students.studentHouseId, id), isNull(students.deletedAt)));
  return { ...toRow(house), studentCount: total };
}

export async function createStudentHouse(tenant: TenantContext, _actor: AuthUser, input: CreateStudentHouseInput) {
  if (input.houseMasterId) await assertStaffInTenant(tenant.id, input.houseMasterId);
  try {
    const [row] = await db
      .insert(studentHouses)
      .values({
        tenantId: tenant.id,
        name: input.name,
        color: input.color ?? null,
        motto: input.motto ?? null,
        houseMasterId: input.houseMasterId ?? null,
        isActive: input.isActive ?? true,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, HOUSE_NAME_TAKEN);
    throw e;
  }
}

export async function updateStudentHouse(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateStudentHouseInput,
) {
  await loadHouse(tenant.id, id);
  if (input.houseMasterId) await assertStaffInTenant(tenant.id, input.houseMasterId);
  try {
    const [row] = await db
      .update(studentHouses)
      .set(input)
      .where(and(eq(studentHouses.id, id), eq(studentHouses.tenantId, tenant.id), isNull(studentHouses.deletedAt)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, HOUSE_NAME_TAKEN);
    throw e;
  }
}

export async function removeStudentHouse(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadHouse(tenant.id, id);
  const [{ total }] = await db
    .select({ total: count() })
    .from(students)
    .where(and(eq(students.tenantId, tenant.id), eq(students.studentHouseId, id), isNull(students.deletedAt)));
  if (total > 0) throw new HttpError(409, 'Reassign students in this house first');
  await db
    .update(studentHouses)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(studentHouses.id, id), eq(studentHouses.tenantId, tenant.id)));
}

// ================================================================ GUARDIANS
export async function listGuardians(tenant: TenantContext, q: ListGuardiansInput) {
  const where = and(
    eq(guardians.tenantId, tenant.id),
    isNull(guardians.deletedAt),
    q.relation ? eq(guardians.relation, q.relation) : undefined,
    q.isEmergencyContact !== undefined ? eq(guardians.isEmergencyContact, q.isEmergencyContact) : undefined,
    q.q
      ? or(
          ilike(guardians.fullName, `%${q.q}%`),
          ilike(guardians.phone, `%${q.q}%`),
          ilike(guardians.email, `%${q.q}%`),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(guardians).where(where).orderBy(asc(guardians.fullName), asc(guardians.id)).offset((q.page - 1) * q.limit).limit(q.limit),
    db.select({ total: count() }).from(guardians).where(where),
  ]);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function getGuardian(tenant: TenantContext, id: bigint) {
  const guardian = await loadGuardian(tenant.id, id);
  const linkedStudents = await db
    .select({
      studentId: students.id,
      admissionNo: students.admissionNo,
      fullName: students.fullName,
      status: students.status,
      isPrimary: studentGuardians.isPrimary,
      canPickUp: studentGuardians.canPickUp,
    })
    .from(studentGuardians)
    .innerJoin(students, eq(studentGuardians.studentId, students.id))
    .where(and(eq(studentGuardians.tenantId, tenant.id), eq(studentGuardians.guardianId, id), isNull(students.deletedAt)))
    .orderBy(asc(students.fullName));

  return { ...toRow(guardian), students: linkedStudents };
}

export async function createGuardian(tenant: TenantContext, _actor: AuthUser, input: CreateGuardianInput) {
  try {
    const [row] = await db
      .insert(guardians)
      .values({
        ...guardianToColumns(input),
        tenantId: tenant.id,
        fullName: input.fullName,
        relation: input.relation,
        phone: input.phone,
        isEmergencyContact: input.isEmergencyContact ?? false,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function updateGuardian(tenant: TenantContext, _actor: AuthUser, id: bigint, input: UpdateGuardianInput) {
  await loadGuardian(tenant.id, id);
  try {
    const [row] = await db
      .update(guardians)
      .set(guardianToColumns(input))
      .where(and(eq(guardians.id, id), eq(guardians.tenantId, tenant.id), isNull(guardians.deletedAt)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function removeGuardian(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadGuardian(tenant.id, id);
  const [{ total }] = await db
    .select({ total: count() })
    .from(studentGuardians)
    .innerJoin(students, eq(studentGuardians.studentId, students.id))
    .where(and(eq(studentGuardians.tenantId, tenant.id), eq(studentGuardians.guardianId, id), isNull(students.deletedAt)));
  if (total > 0) throw new HttpError(409, 'Unlink this guardian from active students first');

  await db
    .update(guardians)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(guardians.id, id), eq(guardians.tenantId, tenant.id)));
}

// ================================================================ STUDENTS
async function loadStudentGuardiansList(tenantId: bigint, studentId: bigint, runner: Tx | typeof db = db) {
  return runner
    .select({
      ...getTableColumns(guardians),
      isPrimary: studentGuardians.isPrimary,
      canPickUp: studentGuardians.canPickUp,
      linkedAt: studentGuardians.createdAt,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(studentGuardians.guardianId, guardians.id))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        eq(studentGuardians.studentId, studentId),
        isNull(guardians.deletedAt),
      ),
    )
    .orderBy(desc(studentGuardians.isPrimary), asc(guardians.fullName));
}

async function loadStudentDocumentsList(tenantId: bigint, studentId: bigint, runner: Tx | typeof db = db) {
  return runner
    .select({
      ...getTableColumns(studentDocuments),
      verifiedByName: users.fullName,
    })
    .from(studentDocuments)
    .leftJoin(users, eq(studentDocuments.verifiedBy, users.id))
    .where(and(eq(studentDocuments.tenantId, tenantId), eq(studentDocuments.studentId, studentId)))
    .orderBy(desc(studentDocuments.createdAt), desc(studentDocuments.id));
}

export async function listStudents(tenant: TenantContext, q: ListStudentsInput) {
  const where = and(
    eq(students.tenantId, tenant.id),
    isNull(students.deletedAt),
    q.status ? eq(students.status, q.status) : undefined,
    q.studentHouseId ? eq(students.studentHouseId, q.studentHouseId) : undefined,
    q.gender ? eq(students.gender, q.gender) : undefined,
    q.q
      ? or(
          ilike(students.admissionNo, `%${q.q}%`),
          ilike(students.firstName, `%${q.q}%`),
          ilike(students.lastName, `%${q.q}%`),
          ilike(students.fullName, `%${q.q}%`),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(students),
        houseName: studentHouses.name,
        primaryGuardianName: guardians.fullName,
        primaryGuardianPhone: guardians.phone,
      })
      .from(students)
      .leftJoin(studentHouses, eq(students.studentHouseId, studentHouses.id))
      .leftJoin(guardians, eq(students.primaryGuardianId, guardians.id))
      .where(where)
      .orderBy(asc(students.admissionNo), asc(students.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(students).where(where),
  ]);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function getStudent(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select({
      ...getTableColumns(students),
      houseName: studentHouses.name,
      houseColor: studentHouses.color,
    })
    .from(students)
    .leftJoin(studentHouses, eq(students.studentHouseId, studentHouses.id))
    .where(and(eq(students.id, id), eq(students.tenantId, tenant.id), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Student not found');

  const [guardianList, documentList, admission] = await Promise.all([
    loadStudentGuardiansList(tenant.id, id),
    loadStudentDocumentsList(tenant.id, id),
    row.admissionId
      ? db
          .select({ id: admissions.id, applicationNo: admissions.applicationNo, status: admissions.status, appliedOn: admissions.appliedOn })
          .from(admissions)
          .where(and(eq(admissions.id, row.admissionId), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  return {
    ...toRow(row),
    admission,
    guardians: guardianList.map(toRow),
    documents: documentList.map(toRow),
  };
}

export async function createStudent(tenant: TenantContext, _actor: AuthUser, input: CreateStudentInput) {
  if (input.userId) await assertUserRelation(tenant.id, input.userId);
  if (input.admissionId) await assertAdmissionRelation(tenant.id, input.admissionId);
  if (input.studentHouseId) await assertHouseInTenant(tenant.id, input.studentHouseId);
  if (input.primaryGuardianId) await loadGuardian(tenant.id, input.primaryGuardianId);

  const status = input.status ?? 'active';
  if (LEFT_STATUSES.has(status) && !input.leftOn) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'leftOn', message: `Required when status is ${status}` },
    ]);
  }

  const inlineGuardians = input.guardians ?? [];
  if (inlineGuardians.length > 0) {
    const gIds = inlineGuardians.map((g) => g.guardianId);
    if (new Set(gIds).size !== gIds.length) {
      throw new HttpError(400, 'Validation failed', [{ field: 'guardians', message: 'Duplicate guardianId in list' }]);
    }
    if (inlineGuardians.filter((g) => g.isPrimary).length > 1) {
      throw new HttpError(400, 'Validation failed', [{ field: 'guardians', message: 'Only one guardian can be primary' }]);
    }
    const found = await db
      .select({ id: guardians.id })
      .from(guardians)
      .where(and(eq(guardians.tenantId, tenant.id), isNull(guardians.deletedAt), inArray(guardians.id, gIds)));
    const missing = gIds.filter((gid) => !found.some((f) => f.id === gid));
    if (missing.length > 0) {
      throw new HttpError(400, `Guardian not found in this school: ${missing.join(', ')}`);
    }
  }

  const admittedOn = input.admittedOn ?? todayStr();
  const year = admittedOn.slice(0, 4);
  const { guardians: _g, ...studentData } = input;
  const primaryFromList = inlineGuardians.find((g) => g.isPrimary)?.guardianId;
  const primaryGuardianId = primaryFromList ?? input.primaryGuardianId ?? null;

  try {
    return await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const admissionNo = input.admissionNo ?? (await nextAdmissionNo(tx, tenant.id, year, attempt));
        try {
          const [createdRow] = await tx
            .insert(students)
            .values({
              ...(studentData as Partial<StudentInsert>),
              tenantId: tenant.id,
              admissionNo,
              firstName: input.firstName,
              lastName: input.lastName,
              fullName: input.fullName ?? joinName(input.firstName, input.lastName),
              dob: input.dob,
              primaryGuardianId,
              status,
              admittedOn,
            })
            .returning();

          if (inlineGuardians.length > 0) {
            await tx.insert(studentGuardians).values(
              inlineGuardians.map((g) => ({
                studentId: createdRow.id,
                guardianId: g.guardianId,
                tenantId: tenant.id,
                isPrimary: g.isPrimary,
                canPickUp: g.canPickUp,
              })),
            );
          }

          if (primaryGuardianId && !inlineGuardians.some((g) => g.guardianId === primaryGuardianId)) {
            await tx.insert(studentGuardians).values({
              studentId: createdRow.id,
              guardianId: primaryGuardianId,
              tenantId: tenant.id,
              isPrimary: true,
              canPickUp: true,
            });
          }

          if (input.admissionId) {
            await tx
              .update(admissions)
              .set({ studentId: createdRow.id })
              .where(and(eq(admissions.id, input.admissionId), eq(admissions.tenantId, tenant.id), isNull(admissions.studentId)));
          }

          const linkedGuardians = await loadStudentGuardiansList(tenant.id, createdRow.id, tx);
          return { ...toRow(createdRow), guardians: linkedGuardians.map(toRow) };
        } catch (e) {
          if (!isUniqueViolation(e) || input.admissionNo) throw e;
        }
      }
      throw new HttpError(409, 'Could not generate an admission number, please try again');
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That admission number or admission link is already used in this school');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function updateStudent(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateStudentInput,
) {
  const existing = await loadStudent(tenant.id, id);
  if (input.userId) await assertUserRelation(tenant.id, input.userId, id);
  if (input.admissionId) await assertAdmissionRelation(tenant.id, input.admissionId, id);
  if (input.studentHouseId) await assertHouseInTenant(tenant.id, input.studentHouseId);
  if (input.primaryGuardianId) await loadGuardian(tenant.id, input.primaryGuardianId);

  const nextStatus = input.status ?? existing.status;
  const nextLeftOn = input.leftOn !== undefined ? input.leftOn : existing.leftOn;
  if (LEFT_STATUSES.has(nextStatus) && !nextLeftOn) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'leftOn', message: `Required when status is ${nextStatus}` },
    ]);
  }

  const nextFirst = input.firstName ?? existing.firstName;
  const nextLast = input.lastName ?? existing.lastName;
  const computedFullName =
    input.fullName !== undefined
      ? input.fullName
      : input.firstName !== undefined || input.lastName !== undefined
        ? joinName(nextFirst, nextLast)
        : existing.fullName;

  try {
    return await db.transaction(async (tx) => {
      if (input.primaryGuardianId !== undefined) {
        await tx
          .update(studentGuardians)
          .set({ isPrimary: false })
          .where(and(eq(studentGuardians.tenantId, tenant.id), eq(studentGuardians.studentId, id)));

        if (input.primaryGuardianId !== null) {
          const [existingLink] = await tx
            .select()
            .from(studentGuardians)
            .where(and(eq(studentGuardians.studentId, id), eq(studentGuardians.guardianId, input.primaryGuardianId)))
            .limit(1);
          if (existingLink) {
            await tx
              .update(studentGuardians)
              .set({ isPrimary: true })
              .where(and(eq(studentGuardians.studentId, id), eq(studentGuardians.guardianId, input.primaryGuardianId)));
          } else {
            await tx.insert(studentGuardians).values({
              studentId: id,
              guardianId: input.primaryGuardianId,
              tenantId: tenant.id,
              isPrimary: true,
              canPickUp: true,
            });
          }
        }
      }

      const [row] = await tx
        .update(students)
        .set({
          ...(input as Partial<StudentInsert>),
          fullName: computedFullName,
        })
        .where(and(eq(students.id, id), eq(students.tenantId, tenant.id), isNull(students.deletedAt)))
        .returning();
      return toRow(row);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That admission number or admission link is already used in this school');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function updateStudentStatus(
  tenant: TenantContext,
  actor: AuthUser,
  id: bigint,
  input: UpdateStudentStatusInput,
) {
  return updateStudent(tenant, actor, id, input);
}

export async function removeStudent(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadStudent(tenant.id, id);
  await db
    .update(students)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(students.id, id), eq(students.tenantId, tenant.id)));
}

// ================================================================ STUDENT-GUARDIAN LINKS
export async function listStudentGuardians(tenant: TenantContext, studentId: bigint) {
  await loadStudent(tenant.id, studentId);
  const rows = await loadStudentGuardiansList(tenant.id, studentId);
  return rows.map(toRow);
}

export async function linkStudentGuardian(
  tenant: TenantContext,
  _actor: AuthUser,
  studentId: bigint,
  input: LinkStudentGuardianInput,
) {
  await loadStudent(tenant.id, studentId);

  if (input.guardianId) {
    await loadGuardian(tenant.id, input.guardianId);
    const [exists] = await db
      .select()
      .from(studentGuardians)
      .where(and(eq(studentGuardians.studentId, studentId), eq(studentGuardians.guardianId, input.guardianId)))
      .limit(1);
    if (exists) throw new HttpError(409, 'This guardian is already linked to this student');
  }

  try {
    await db.transaction(async (tx) => {
      let guardianId = input.guardianId;
      if (!guardianId && input.guardian) {
        const [createdGuardian] = await tx
          .insert(guardians)
          .values({
            ...guardianToColumns(input.guardian),
            tenantId: tenant.id,
            fullName: input.guardian.fullName,
            relation: input.guardian.relation,
            phone: input.guardian.phone,
            isEmergencyContact: input.guardian.isEmergencyContact ?? false,
          })
          .returning();
        guardianId = createdGuardian.id;
      }

      if (input.isPrimary) {
        await tx
          .update(studentGuardians)
          .set({ isPrimary: false })
          .where(and(eq(studentGuardians.tenantId, tenant.id), eq(studentGuardians.studentId, studentId)));
        await tx
          .update(students)
          .set({ primaryGuardianId: guardianId! })
          .where(and(eq(students.id, studentId), eq(students.tenantId, tenant.id)));
      }

      await tx.insert(studentGuardians).values({
        studentId,
        guardianId: guardianId!,
        tenantId: tenant.id,
        isPrimary: input.isPrimary,
        canPickUp: input.canPickUp,
      });
    });

    const rows = await loadStudentGuardiansList(tenant.id, studentId);
    return rows.map(toRow);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'This guardian is already linked to this student');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function updateStudentGuardian(
  tenant: TenantContext,
  _actor: AuthUser,
  studentId: bigint,
  guardianId: bigint,
  input: UpdateStudentGuardianInput,
) {
  const student = await loadStudent(tenant.id, studentId);
  await loadGuardian(tenant.id, guardianId);

  const [existing] = await db
    .select()
    .from(studentGuardians)
    .where(
      and(
        eq(studentGuardians.tenantId, tenant.id),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
      ),
    )
    .limit(1);
  if (!existing) throw new HttpError(404, 'Guardian is not linked to this student');

  await db.transaction(async (tx) => {
    if (input.isPrimary === true) {
      await tx
        .update(studentGuardians)
        .set({ isPrimary: false })
        .where(and(eq(studentGuardians.tenantId, tenant.id), eq(studentGuardians.studentId, studentId)));
      await tx
        .update(students)
        .set({ primaryGuardianId: guardianId })
        .where(and(eq(students.id, studentId), eq(students.tenantId, tenant.id)));
    } else if (input.isPrimary === false && student.primaryGuardianId === guardianId) {
      await tx
        .update(students)
        .set({ primaryGuardianId: null })
        .where(and(eq(students.id, studentId), eq(students.tenantId, tenant.id)));
    }

    await tx
      .update(studentGuardians)
      .set({
        ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
        ...(input.canPickUp !== undefined ? { canPickUp: input.canPickUp } : {}),
      })
      .where(and(eq(studentGuardians.studentId, studentId), eq(studentGuardians.guardianId, guardianId)));
  });

  const rows = await loadStudentGuardiansList(tenant.id, studentId);
  return rows.map(toRow);
}

export async function unlinkStudentGuardian(
  tenant: TenantContext,
  _actor: AuthUser,
  studentId: bigint,
  guardianId: bigint,
): Promise<void> {
  const student = await loadStudent(tenant.id, studentId);
  const [existing] = await db
    .select()
    .from(studentGuardians)
    .where(
      and(
        eq(studentGuardians.tenantId, tenant.id),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
      ),
    )
    .limit(1);
  if (!existing) throw new HttpError(404, 'Guardian is not linked to this student');

  await db.transaction(async (tx) => {
    await tx
      .delete(studentGuardians)
      .where(and(eq(studentGuardians.studentId, studentId), eq(studentGuardians.guardianId, guardianId)));
    if (student.primaryGuardianId === guardianId) {
      await tx
        .update(students)
        .set({ primaryGuardianId: null })
        .where(and(eq(students.id, studentId), eq(students.tenantId, tenant.id)));
    }
  });
}

// ================================================================ STUDENT DOCUMENTS
async function loadDocument(tenantId: bigint, studentId: bigint, docId: bigint) {
  const [row] = await db
    .select()
    .from(studentDocuments)
    .where(
      and(
        eq(studentDocuments.id, docId),
        eq(studentDocuments.studentId, studentId),
        eq(studentDocuments.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'Student document not found');
  return row;
}

export async function listStudentDocuments(tenant: TenantContext, studentId: bigint) {
  await loadStudent(tenant.id, studentId);
  const rows = await loadStudentDocumentsList(tenant.id, studentId);
  return rows.map(toRow);
}

export async function addStudentDocument(
  tenant: TenantContext,
  _actor: AuthUser,
  studentId: bigint,
  input: CreateStudentDocumentInput,
) {
  await loadStudent(tenant.id, studentId);
  if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) {
    throw new HttpError(400, 'Validation failed', [{ field: 'expiresOn', message: 'Cannot be before issuedOn' }]);
  }

  try {
    const [row] = await db
      .insert(studentDocuments)
      .values({
        tenantId: tenant.id,
        studentId,
        documentType: input.documentType,
        fileId: input.fileId,
        documentNo: input.documentNo ?? null,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        remarks: input.remarks ?? null,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid fileId provided');
    throw e;
  }
}

export async function updateStudentDocument(
  tenant: TenantContext,
  _actor: AuthUser,
  studentId: bigint,
  docId: bigint,
  input: UpdateStudentDocumentInput,
) {
  await loadStudent(tenant.id, studentId);
  const existing = await loadDocument(tenant.id, studentId, docId);

  const issuedOn = input.issuedOn !== undefined ? input.issuedOn : existing.issuedOn;
  const expiresOn = input.expiresOn !== undefined ? input.expiresOn : existing.expiresOn;
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    throw new HttpError(400, 'Validation failed', [{ field: 'expiresOn', message: 'Cannot be before issuedOn' }]);
  }

  try {
    const [row] = await db
      .update(studentDocuments)
      .set(input)
      .where(
        and(
          eq(studentDocuments.id, docId),
          eq(studentDocuments.studentId, studentId),
          eq(studentDocuments.tenantId, tenant.id),
        ),
      )
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid fileId provided');
    throw e;
  }
}

export async function verifyStudentDocument(
  tenant: TenantContext,
  actor: AuthUser,
  studentId: bigint,
  docId: bigint,
  input: VerifyStudentDocumentInput,
) {
  await loadStudent(tenant.id, studentId);
  const existing = await loadDocument(tenant.id, studentId, docId);

  const isPending = input.verifiedStatus === 'pending';
  const [row] = await db
    .update(studentDocuments)
    .set({
      verifiedStatus: input.verifiedStatus,
      verifiedBy: isPending ? null : actor.id,
      verifiedAt: isPending ? null : new Date(),
      remarks: input.remarks !== undefined ? input.remarks : existing.remarks,
    })
    .where(
      and(
        eq(studentDocuments.id, docId),
        eq(studentDocuments.studentId, studentId),
        eq(studentDocuments.tenantId, tenant.id),
      ),
    )
    .returning();
  return toRow(row);
}

export async function removeStudentDocument(
  tenant: TenantContext,
  studentId: bigint,
  docId: bigint,
): Promise<void> {
  await loadStudent(tenant.id, studentId);
  await loadDocument(tenant.id, studentId, docId);
  await db
    .delete(studentDocuments)
    .where(
      and(
        eq(studentDocuments.id, docId),
        eq(studentDocuments.studentId, studentId),
        eq(studentDocuments.tenantId, tenant.id),
      ),
    );
}
