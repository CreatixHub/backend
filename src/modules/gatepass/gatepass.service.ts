import crypto from 'node:crypto';
import { and, count, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { db } from '../../db';
import { exitPasses, guardians, staff, studentGuardians, students } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import {
  assertStudentReadable,
  assertStudentWritable,
  resolveStudentScope,
  studentScopeCondition,
} from '../../lib/ownership';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateExitPassInput,
  DecideExitPassInput,
  ListExitPassesInput,
  ReturnExitPassInput,
  UpdateExitPassInput,
  UseExitPassInput,
  VerifyExitPassInput,
} from './gatepass.schemas';

const toRow = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const genPassCode = () => `EP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function assertStudentInTenant(tenantId: bigint, studentId: bigint) {
  const [row] = await db
    .select({ id: students.id, fullName: students.fullName, admissionNo: students.admissionNo })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Student not found in this school');
  return row;
}

async function assertStaffInTenant(tenantId: bigint, staffId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Staff member not found in this school');
  return row;
}

async function assertStudentGuardianLink(
  tenantId: bigint,
  studentId: bigint,
  guardianId: bigint,
  requirePickupAuth: boolean,
) {
  const [row] = await db
    .select({
      guardianId: studentGuardians.guardianId,
      canPickUp: studentGuardians.canPickUp,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(studentGuardians.guardianId, guardians.id))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
        isNull(guardians.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new HttpError(400, 'Guardian is not linked to this student');
  }
  if (requirePickupAuth && !row.canPickUp) {
    throw new HttpError(403, 'This guardian is not authorized to pick up this student');
  }
  return row;
}

export async function listExitPasses(tenant: TenantContext, actor: AuthUser, q: ListExitPassesInput) {
  const scope = await resolveStudentScope(tenant, actor.id, 'gatepass.view');
  const scopeCond = studentScopeCondition(exitPasses.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const conditions = [eq(exitPasses.tenantId, tenant.id)];
  if (scopeCond) conditions.push(scopeCond);
  if (q.studentId !== undefined) conditions.push(eq(exitPasses.studentId, q.studentId));
  if (q.status !== undefined) conditions.push(eq(exitPasses.status, q.status));
  if (q.reasonType !== undefined) conditions.push(eq(exitPasses.reasonType, q.reasonType));
  if (q.passCode !== undefined) conditions.push(eq(exitPasses.passCode, q.passCode));
  if (q.from !== undefined) conditions.push(gte(exitPasses.requestedExitAt, q.from));
  if (q.to !== undefined) conditions.push(lte(exitPasses.requestedExitAt, q.to));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(exitPasses).where(where);
  const rows = await db
    .select()
    .from(exitPasses)
    .where(where)
    .orderBy(desc(exitPasses.requestedExitAt), desc(exitPasses.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getExitPass(tenant: TenantContext, actor: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, actor.id, 'gatepass.view');
  const [row] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Exit pass not found');
  assertStudentReadable(scope, row.studentId, 'Exit pass not found');
  return toRow(row);
}

export async function createExitPass(tenant: TenantContext, actor: AuthUser, data: CreateExitPassInput) {
  const scope = await resolveStudentScope(tenant, actor.id, 'gatepass.create');
  let requestedByGuardianId = data.requestedByGuardianId ?? null;

  if (scope.scoped) {
    assertStudentWritable(scope, data.studentId);
    if (data.requestedByStaffId != null) {
      throw new HttpError(403, 'Students and parents cannot specify requestedByStaffId');
    }
    if (requestedByGuardianId != null && !scope.guardianIds.includes(requestedByGuardianId)) {
      throw new HttpError(403, 'Cannot request a pass on behalf of another guardian');
    }
    if (requestedByGuardianId == null && scope.guardianIds.length === 1) {
      requestedByGuardianId = scope.guardianIds[0];
    }
  }

  await assertStudentInTenant(tenant.id, data.studentId);
  if (requestedByGuardianId != null) {
    await assertStudentGuardianLink(tenant.id, data.studentId, requestedByGuardianId, false);
  }
  if (data.requestedByStaffId != null) {
    await assertStaffInTenant(tenant.id, data.requestedByStaffId);
  }
  if (data.pickedUpByGuardianId != null) {
    await assertStudentGuardianLink(tenant.id, data.studentId, data.pickedUpByGuardianId, true);
  }

  try {
    const [row] = await db
      .insert(exitPasses)
      .values({
        tenantId: tenant.id,
        studentId: data.studentId,
        requestedByGuardianId,
        requestedByStaffId: data.requestedByStaffId ?? null,
        reason: data.reason,
        reasonType: data.reasonType,
        requestedExitAt: data.requestedExitAt,
        expectedReturnAt: data.expectedReturnAt,
        status: 'pending',
        pickedUpByGuardianId: data.pickedUpByGuardianId ?? null,
        authorizedPersonName: data.authorizedPersonName ?? null,
        authorizedPersonRelation: data.authorizedPersonRelation ?? null,
        passCode: data.passCode ?? genPassCode(),
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'An exit pass with this passCode already exists');
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in exit pass');
    throw e;
  }
}

export async function updateExitPass(tenant: TenantContext, actor: AuthUser, id: bigint, data: UpdateExitPassInput) {
  const scope = await resolveStudentScope(tenant, actor.id, 'gatepass.edit');
  const [existing] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Exit pass not found');
  assertStudentReadable(scope, existing.studentId, 'Exit pass not found');
  if (existing.status !== 'pending') {
    throw new HttpError(409, 'Only pending exit passes can be edited');
  }

  const reqExit = data.requestedExitAt ?? existing.requestedExitAt;
  const expRet = data.expectedReturnAt ?? existing.expectedReturnAt;
  if (expRet < reqExit) throw new HttpError(400, 'expectedReturnAt must be on or after requestedExitAt');

  if (data.pickedUpByGuardianId != null && existing.studentId != null) {
    await assertStudentGuardianLink(tenant.id, existing.studentId, data.pickedUpByGuardianId, true);
  }

  const patch: Partial<typeof exitPasses.$inferInsert> = {};
  if (data.reason !== undefined) patch.reason = data.reason;
  if (data.reasonType !== undefined) patch.reasonType = data.reasonType;
  if (data.requestedExitAt !== undefined) patch.requestedExitAt = data.requestedExitAt;
  if (data.expectedReturnAt !== undefined) patch.expectedReturnAt = data.expectedReturnAt;
  if (data.pickedUpByGuardianId !== undefined) patch.pickedUpByGuardianId = data.pickedUpByGuardianId;
  if (data.authorizedPersonName !== undefined) patch.authorizedPersonName = data.authorizedPersonName;
  if (data.authorizedPersonRelation !== undefined) patch.authorizedPersonRelation = data.authorizedPersonRelation;

  const [updated] = await db
    .update(exitPasses)
    .set(patch)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function decideExitPass(tenant: TenantContext, actor: AuthUser, id: bigint, data: DecideExitPassInput) {
  const [existing] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Exit pass not found');
  if (existing.status !== 'pending') {
    throw new HttpError(409, `Exit pass is already ${existing.status}`);
  }

  const [updated] = await db
    .update(exitPasses)
    .set({
      status: data.decision,
      approvedBy: actor.id,
      approvedAt: new Date(),
      rejectionReason: data.decision === 'rejected' ? (data.rejectionReason ?? null) : null,
    })
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function revokeExitPass(tenant: TenantContext, actor: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, actor.id, 'gatepass.edit');
  const [existing] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Exit pass not found');
  assertStudentReadable(scope, existing.studentId, 'Exit pass not found');
  if (existing.status !== 'pending' && existing.status !== 'approved') {
    throw new HttpError(409, `Cannot revoke a ${existing.status} exit pass`);
  }

  const [updated] = await db
    .update(exitPasses)
    .set({ status: 'revoked' })
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function verifyExitPassByCode(tenant: TenantContext, data: VerifyExitPassInput) {
  const [pass] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.tenantId, tenant.id), eq(exitPasses.passCode, data.passCode)))
    .limit(1);
  if (!pass) throw new HttpError(404, 'Exit pass not found for this passCode');

  const valid = pass.status === 'approved' && pass.usedAt === null;
  let student = null;
  if (pass.studentId != null) {
    const [st] = await db
      .select({ id: students.id, admissionNo: students.admissionNo, fullName: students.fullName })
      .from(students)
      .where(and(eq(students.id, pass.studentId), eq(students.tenantId, tenant.id)))
      .limit(1);
    student = st ?? null;
  }

  return { valid, pass: toRow(pass), student };
}

export async function useExitPass(tenant: TenantContext, id: bigint, data: UseExitPassInput) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(exitPasses)
      .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
      .limit(1);
    if (!existing) throw new HttpError(404, 'Exit pass not found');
    if (existing.status !== 'approved' || existing.usedAt !== null) {
      throw new HttpError(409, `Exit pass cannot be used (status: ${existing.status})`);
    }

    const pickupGuardianId = data.pickedUpByGuardianId !== undefined ? data.pickedUpByGuardianId : existing.pickedUpByGuardianId;
    if (pickupGuardianId != null && existing.studentId != null) {
      await assertStudentGuardianLink(tenant.id, existing.studentId, pickupGuardianId, true);
    }

    const now = new Date();
    const [updated] = await tx
      .update(exitPasses)
      .set({
        status: 'used',
        usedAt: now,
        actualExitAt: data.actualExitAt ?? now,
        pickedUpByGuardianId: pickupGuardianId ?? null,
        authorizedPersonName:
          data.authorizedPersonName !== undefined ? data.authorizedPersonName : existing.authorizedPersonName,
        authorizedPersonRelation:
          data.authorizedPersonRelation !== undefined
            ? data.authorizedPersonRelation
            : existing.authorizedPersonRelation,
      })
      .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  });
}

export async function recordExitPassReturn(tenant: TenantContext, id: bigint, data: ReturnExitPassInput) {
  const [existing] = await db
    .select()
    .from(exitPasses)
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Exit pass not found');
  if (existing.status !== 'used') {
    throw new HttpError(409, 'Only used exit passes can record student return');
  }

  const returnTime = data.actualReturnAt ?? new Date();
  if (existing.actualExitAt && returnTime < existing.actualExitAt) {
    throw new HttpError(400, 'actualReturnAt must be on or after actualExitAt');
  }

  const [updated] = await db
    .update(exitPasses)
    .set({ actualReturnAt: returnTime })
    .where(and(eq(exitPasses.id, id), eq(exitPasses.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}
