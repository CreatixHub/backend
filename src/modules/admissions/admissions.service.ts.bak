import { and, asc, count, desc, eq, getTableColumns, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  admissions,
  admissionStatusHistory,
  classes,
  guardians,
  staff,
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
  AcceptAdmissionInput,
  ChangeAdmissionStatusInput,
  CreateAdmissionInput,
  ListAdmissionsInput,
  UpdateAdmissionInput,
} from './admissions.schemas';

type AdmissionRow = typeof admissions.$inferSelect;
type AdmissionInsert = typeof admissions.$inferInsert;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const HIDDEN = new Set<string>(['tenantId', 'deletedAt']);
const toAdmission = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.has(k)));
const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'tenantId'));

const todayStr = () => new Date().toISOString().slice(0, 10);
const joinName = (first: string, last: string) => [first, last].filter(Boolean).join(' ');
const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

async function loadAdmission(tenantId: bigint, id: bigint, runner: Tx | typeof db = db): Promise<AdmissionRow> {
  const [row] = await runner
    .select()
    .from(admissions)
    .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenantId), isNull(admissions.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Admission not found');
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

async function assertStaff(tenantId: bigint, staffId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Assigned staff member not found in this school');
}

async function assertHouse(tenantId: bigint, houseId: bigint) {
  const [row] = await db
    .select({ id: studentHouses.id })
    .from(studentHouses)
    .where(and(eq(studentHouses.id, houseId), eq(studentHouses.tenantId, tenantId), isNull(studentHouses.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Student house not found in this school');
}

async function nextApplicationNo(tx: Tx, tenantId: bigint, year: string, offset: number): Promise<string> {
  const prefix = `APP-${year}-`;
  const [r] = await tx
    .select({ max: sql<number | null>`max(substring(${admissions.applicationNo} from ${prefix.length + 1})::int)` })
    .from(admissions)
    .where(and(eq(admissions.tenantId, tenantId), sql`${admissions.applicationNo} ~ ${'^APP-' + year + '-[0-9]+$'}`));
  return `${prefix}${String(Number(r?.max ?? 0) + 1 + offset).padStart(4, '0')}`;
}

async function nextStudentAdmissionNo(tx: Tx, tenantId: bigint, year: string, offset: number): Promise<string> {
  const prefix = `STU-${year}-`;
  const [r] = await tx
    .select({ max: sql<number | null>`max(substring(${students.admissionNo} from ${prefix.length + 1})::int)` })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), sql`${students.admissionNo} ~ ${'^STU-' + year + '-[0-9]+$'}`));
  return `${prefix}${String(Number(r?.max ?? 0) + 1 + offset).padStart(4, '0')}`;
}

function toColumns(input: Partial<CreateAdmissionInput>): Partial<AdmissionInsert> {
  const { applicationFee, acknowledgedAt, status: _s, note: _n, ...plain } = input as Partial<CreateAdmissionInput> & {
    status?: string;
    note?: string | null;
  };
  const cols: Partial<AdmissionInsert> = { ...plain };
  if (applicationFee !== undefined) {
    cols.applicationFee = applicationFee === null ? null : applicationFee.toFixed(2);
  }
  if (acknowledgedAt !== undefined) {
    cols.acknowledgedAt = acknowledgedAt === null ? null : new Date(acknowledgedAt);
  }
  return cols;
}

async function loadHistory(tenantId: bigint, admissionId: bigint, runner: Tx | typeof db = db) {
  return runner
    .select({
      id: admissionStatusHistory.id,
      admissionId: admissionStatusHistory.admissionId,
      fromStatus: admissionStatusHistory.fromStatus,
      toStatus: admissionStatusHistory.toStatus,
      note: admissionStatusHistory.note,
      changedBy: admissionStatusHistory.changedBy,
      changedByName: users.fullName,
      createdAt: admissionStatusHistory.createdAt,
    })
    .from(admissionStatusHistory)
    .leftJoin(users, eq(admissionStatusHistory.changedBy, users.id))
    .where(and(eq(admissionStatusHistory.tenantId, tenantId), eq(admissionStatusHistory.admissionId, admissionId)))
    .orderBy(asc(admissionStatusHistory.createdAt), asc(admissionStatusHistory.id));
}

export async function listAdmissions(tenant: TenantContext, q: ListAdmissionsInput) {
  const where = and(
    eq(admissions.tenantId, tenant.id),
    isNull(admissions.deletedAt),
    q.status ? eq(admissions.status, q.status) : undefined,
    q.source ? eq(admissions.source, q.source) : undefined,
    q.academicYearId ? eq(admissions.academicYearId, q.academicYearId) : undefined,
    q.classId ? eq(admissions.classId, q.classId) : undefined,
    q.assignedToStaffId ? eq(admissions.assignedToStaffId, q.assignedToStaffId) : undefined,
    q.feePaid !== undefined ? eq(admissions.feePaid, q.feePaid) : undefined,
    q.q
      ? or(
          ilike(admissions.applicationNo, `%${q.q}%`),
          ilike(admissions.firstName, `%${q.q}%`),
          ilike(admissions.lastName, `%${q.q}%`),
          ilike(admissions.guardianName, `%${q.q}%`),
          ilike(admissions.guardianPhone, `%${q.q}%`),
          ilike(admissions.email, `%${q.q}%`),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(admissions),
        className: classes.name,
        assignedToStaffName: staff.fullName,
      })
      .from(admissions)
      .innerJoin(classes, eq(admissions.classId, classes.id))
      .leftJoin(staff, eq(admissions.assignedToStaffId, staff.id))
      .where(where)
      .orderBy(desc(admissions.appliedOn), desc(admissions.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(admissions).where(where),
  ]);

  return { rows: rows.map(toAdmission), meta: pageMeta(q.page, q.limit, total) };
}

export async function getAdmission(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select({
      ...getTableColumns(admissions),
      className: classes.name,
      assignedToStaffName: staff.fullName,
    })
    .from(admissions)
    .innerJoin(classes, eq(admissions.classId, classes.id))
    .leftJoin(staff, eq(admissions.assignedToStaffId, staff.id))
    .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Admission not found');

  const [history, linkedStudent] = await Promise.all([
    loadHistory(tenant.id, id),
    row.studentId
      ? db
          .select({
            id: students.id,
            admissionNo: students.admissionNo,
            fullName: students.fullName,
            status: students.status,
            admittedOn: students.admittedOn,
          })
          .from(students)
          .where(and(eq(students.id, row.studentId), eq(students.tenantId, tenant.id), isNull(students.deletedAt)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  return {
    ...toAdmission(row),
    student: linkedStudent,
    history,
  };
}

export async function getAdmissionHistory(tenant: TenantContext, id: bigint) {
  await loadAdmission(tenant.id, id);
  return loadHistory(tenant.id, id);
}

export async function createAdmission(tenant: TenantContext, actor: AuthUser, input: CreateAdmissionInput) {
  await assertClass(tenant.id, input.classId);
  if (input.assignedToStaffId) await assertStaff(tenant.id, input.assignedToStaffId);

  const appliedOn = input.appliedOn ?? todayStr();
  const initialStatus = input.status ?? 'applied';
  const year = appliedOn.slice(0, 4);
  const columns = toColumns(input);

  try {
    return await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const applicationNo = input.applicationNo ?? (await nextApplicationNo(tx, tenant.id, year, attempt));
        try {
          const [createdRow] = await tx
            .insert(admissions)
            .values({
              ...columns,
              tenantId: tenant.id,
              applicationNo,
              academicYearId: input.academicYearId,
              classId: input.classId,
              firstName: input.firstName,
              lastName: input.lastName,
              dob: input.dob,
              guardianName: input.guardianName,
              guardianPhone: input.guardianPhone,
              appliedOn,
              status: initialStatus,
              needsTransport: input.needsTransport ?? false,
              needsHostel: input.needsHostel ?? false,
              feePaid: input.feePaid ?? false,
              source: input.source,
            })
            .returning();

          await tx.insert(admissionStatusHistory).values({
            tenantId: tenant.id,
            admissionId: createdRow.id,
            fromStatus: null,
            toStatus: initialStatus,
            note: input.note ?? null,
            changedBy: actor.id,
          });

          const history = await loadHistory(tenant.id, createdRow.id, tx);
          return { ...toAdmission(createdRow), history };
        } catch (e) {
          if (!isUniqueViolation(e) || input.applicationNo) throw e;
        }
      }
      throw new HttpError(409, 'Could not generate an application number, please try again');
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That application number is already used in this school');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function updateAdmission(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateAdmissionInput,
) {
  const existing = await loadAdmission(tenant.id, id);
  if (input.classId) await assertClass(tenant.id, input.classId);
  if (input.assignedToStaffId) await assertStaff(tenant.id, input.assignedToStaffId);

  const feePaid = input.feePaid !== undefined ? input.feePaid : existing.feePaid;
  const feePaidOn = input.feePaidOn !== undefined ? input.feePaidOn : existing.feePaidOn;
  if (feePaidOn && !feePaid) {
    throw new HttpError(400, 'Validation failed', [{ field: 'feePaid', message: 'Must be true when feePaidOn is set' }]);
  }

  try {
    const [row] = await db
      .update(admissions)
      .set(toColumns(input))
      .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)))
      .returning();
    return toAdmission(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That application number is already used in this school');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function changeAdmissionStatus(
  tenant: TenantContext,
  actor: AuthUser,
  id: bigint,
  input: ChangeAdmissionStatusInput,
) {
  const existing = await loadAdmission(tenant.id, id);

  if (existing.status === 'accepted') {
    throw new HttpError(409, 'An accepted admission cannot change status');
  }
  if (existing.status === input.status) {
    throw new HttpError(409, `Admission is already in status "${input.status}"`);
  }
  if ((existing.status === 'rejected' || existing.status === 'withdrawn') && input.status === 'accepted') {
    throw new HttpError(409, `Cannot accept an admission that is ${existing.status}`);
  }
  if (input.status === 'accepted' && input.studentHouseId) {
    await assertHouse(tenant.id, input.studentHouseId);
  }

  const today = todayStr();
  const isDecision = input.status === 'offered' || input.status === 'accepted' || input.status === 'rejected';
  const decisionOn = input.decisionOn ?? (isDecision ? today : existing.decisionOn);

  try {
    return await db.transaction(async (tx) => {
      let linkedStudent: unknown = null;
      let studentId = existing.studentId;

      if (input.status === 'accepted') {
        if (existing.studentId !== null) {
          throw new HttpError(409, 'This admission already has a student record');
        }

        const [guardian] = await tx
          .insert(guardians)
          .values({
            tenantId: tenant.id,
            fullName: existing.guardianName,
            relation: 'guardian',
            phone: existing.guardianPhone,
            email: existing.guardianEmail,
            addressLine1: existing.addressLine1,
            addressLine2: existing.addressLine2,
            cityId: existing.cityId,
            postalCode: existing.postalCode,
            isEmergencyContact: true,
          })
          .returning();

        const admittedOn = input.admittedOn ?? decisionOn ?? today;
        const year = admittedOn.slice(0, 4);

        let createdStudent: typeof students.$inferSelect | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          const admissionNo = input.admissionNo ?? (await nextStudentAdmissionNo(tx, tenant.id, year, attempt));
          try {
            const [stu] = await tx
              .insert(students)
              .values({
                tenantId: tenant.id,
                admissionId: existing.id,
                admissionNo,
                firstName: existing.firstName,
                lastName: existing.lastName,
                fullName: joinName(existing.firstName, existing.lastName),
                dob: existing.dob,
                gender: existing.gender,
                bloodGroup: existing.bloodGroup,
                religionId: existing.religionId,
                socialCategory: existing.socialCategory,
                fatherName: existing.fatherName,
                fatherPhone: existing.fatherPhone,
                fatherEmail: existing.fatherEmail,
                fatherOccupation: existing.fatherOccupation,
                motherName: existing.motherName,
                motherPhone: existing.motherPhone,
                motherEmail: existing.motherEmail,
                motherOccupation: existing.motherOccupation,
                primaryGuardianId: guardian.id,
                addressLine1: existing.addressLine1,
                addressLine2: existing.addressLine2,
                cityId: existing.cityId,
                postalCode: existing.postalCode,
                studentHouseId: input.studentHouseId ?? null,
                status: 'active',
                admittedOn,
              })
              .returning();
            createdStudent = stu;
            break;
          } catch (e) {
            if (!isUniqueViolation(e) || input.admissionNo) throw e;
          }
        }
        if (!createdStudent) {
          throw new HttpError(409, 'Could not generate a student admission number, please try again');
        }

        await tx.insert(studentGuardians).values({
          studentId: createdStudent.id,
          guardianId: guardian.id,
          tenantId: tenant.id,
          isPrimary: true,
          canPickUp: true,
        });

        studentId = createdStudent.id;
        linkedStudent = toRow(createdStudent);
      }

      const [updated] = await tx
        .update(admissions)
        .set({
          status: input.status,
          studentId,
          decisionOn,
          decidedBy: isDecision ? actor.id : existing.decidedBy,
          decisionNotes: input.decisionNotes !== undefined ? input.decisionNotes : existing.decisionNotes,
          rejectionReason:
            input.status === 'rejected'
              ? (input.rejectionReason ?? existing.rejectionReason)
              : input.rejectionReason !== undefined
                ? input.rejectionReason
                : existing.rejectionReason,
          waitlistPosition:
            input.status === 'waitlisted'
              ? (input.waitlistPosition ?? existing.waitlistPosition)
              : input.status !== existing.status
                ? null
                : existing.waitlistPosition,
          acknowledgedAt:
            existing.acknowledgedAt ?? (input.status === 'applied' || input.status === 'document_review' ? new Date() : null),
        })
        .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)))
        .returning();

      await tx.insert(admissionStatusHistory).values({
        tenantId: tenant.id,
        admissionId: id,
        fromStatus: existing.status,
        toStatus: input.status,
        note: input.note ?? input.decisionNotes ?? input.rejectionReason ?? null,
        changedBy: actor.id,
      });

      const history = await loadHistory(tenant.id, id, tx);
      return {
        ...toAdmission(updated),
        ...(linkedStudent ? { student: linkedStudent } : {}),
        history,
      };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'Admission number or student link already exists');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference ID provided');
    throw e;
  }
}

export async function acceptAdmission(
  tenant: TenantContext,
  actor: AuthUser,
  id: bigint,
  input: AcceptAdmissionInput,
) {
  return changeAdmissionStatus(tenant, actor, id, {
    ...input,
    status: 'accepted',
  });
}

export async function removeAdmission(tenant: TenantContext, id: bigint): Promise<void> {
  const existing = await loadAdmission(tenant.id, id);
  if (existing.status === 'accepted' || existing.studentId !== null) {
    throw new HttpError(409, 'An accepted admission linked to a student cannot be deleted');
  }
  await db
    .update(admissions)
    .set({ deletedAt: new Date() })
    .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenant.id)));
}
