import { and, asc, count, desc, eq, gte, ilike, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  academicCalendarEvents,
  attendanceRules,
  classes,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  staff,
  staffAttendance,
  studentAttendance,
  students,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import {
  assertStudentReadable,
  assertStudentWritable,
  isRowScopedFor,
  resolveStudentScope,
  studentScopeCondition,
} from '../../lib/ownership';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pgErrors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  BulkMarkStaffAttendanceInput,
  BulkMarkStudentAttendanceInput,
  CreateAttendanceRuleInput,
  CreateCalendarEventInput,
  CreateLeaveRequestInput,
  CreateLeaveTypeInput,
  DecideLeaveRequestInput,
  ListAttendanceRulesInput,
  ListCalendarEventsInput,
  ListLeaveBalancesInput,
  ListLeaveRequestsInput,
  ListLeaveTypesInput,
  ListStaffAttendanceInput,
  ListStudentAttendanceInput,
  UpdateAttendanceRuleInput,
  UpdateCalendarEventInput,
  UpdateLeaveBalanceInput,
  UpdateLeaveRequestInput,
  UpdateLeaveTypeInput,
  UpsertLeaveBalanceInput,
  UpsertStaffAttendanceInput,
  UpsertStudentAttendanceInput,
} from './attendance.schemas';

const toRow = <T extends object>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

const fixed1 = (n: number | null | undefined): string | null | undefined => (n == null ? n : n.toFixed(1));
const fixed2 = (n: number | null | undefined): string | null | undefined => (n == null ? n : n.toFixed(2));

async function assertStaffInTenant(tenantId: bigint, staffId: bigint) {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Staff member not found in this school');
  return row;
}

async function assertStudentInTenant(tenantId: bigint, studentId: bigint) {
  const [row] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Student not found in this school');
  return row;
}

async function assertClassInTenant(tenantId: bigint, classId: bigint) {
  const [row] = await db
    .select({ id: classes.id })
    .from(classes)
    .where(and(eq(classes.id, classId), eq(classes.tenantId, tenantId), isNull(classes.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Class not found in this school');
  return row;
}

function computeWorkedMinutes(checkIn?: Date | null, checkOut?: Date | null, explicit?: number | null): number | null {
  if (explicit !== undefined) return explicit;
  if (!checkIn || !checkOut) return null;
  if (checkOut < checkIn) throw new HttpError(400, 'checkOut must be after checkIn');
  return Math.round((checkOut.getTime() - checkIn.getTime()) / 60000);
}

// ================================================================ STUDENT ATTENDANCE
export async function listStudentAttendance(tenant: TenantContext, q: ListStudentAttendanceInput) {
  // student_attendance keys only by enrollment_id; fail closed until enrollments table exists
  if (isRowScopedFor(tenant, 'attendance.view')) {
    return { rows: [], meta: pageMeta(q.page, q.limit, 0) };
  }

  const conditions = [eq(studentAttendance.tenantId, tenant.id)];
  if (q.enrollmentId !== undefined) conditions.push(eq(studentAttendance.enrollmentId, q.enrollmentId));
  if (q.dateFrom !== undefined) conditions.push(gte(studentAttendance.attendanceDate, q.dateFrom));
  if (q.dateTo !== undefined) conditions.push(lte(studentAttendance.attendanceDate, q.dateTo));
  if (q.status !== undefined) conditions.push(eq(studentAttendance.status, q.status));
  if (q.source !== undefined) conditions.push(eq(studentAttendance.source, q.source));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(studentAttendance).where(where);
  const rows = await db
    .select()
    .from(studentAttendance)
    .where(where)
    .orderBy(desc(studentAttendance.attendanceDate), asc(studentAttendance.enrollmentId))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getStudentAttendance(tenant: TenantContext, enrollmentId: bigint, attendanceDate: string) {
  if (isRowScopedFor(tenant, 'attendance.view')) {
    throw new HttpError(404, 'Student attendance record not found');
  }

  const [row] = await db
    .select()
    .from(studentAttendance)
    .where(
      and(
        eq(studentAttendance.tenantId, tenant.id),
        eq(studentAttendance.enrollmentId, enrollmentId),
        eq(studentAttendance.attendanceDate, attendanceDate),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'Student attendance record not found');
  return toRow(row);
}

export async function upsertStudentAttendance(
  tenant: TenantContext,
  user: AuthUser,
  data: UpsertStudentAttendanceInput,
) {
  const now = new Date();
  // Check PK ownership before upsert so one school cannot overwrite another school's (enrollmentId, date)
  const [existing] = await db
    .select({ tenantId: studentAttendance.tenantId })
    .from(studentAttendance)
    .where(
      and(
        eq(studentAttendance.enrollmentId, data.enrollmentId),
        eq(studentAttendance.attendanceDate, data.attendanceDate),
      ),
    )
    .limit(1);

  if (existing && existing.tenantId !== tenant.id) {
    throw new HttpError(409, 'Attendance key conflicts with another record');
  }

  if (existing) {
    const [updated] = await db
      .update(studentAttendance)
      .set({
        status: data.status,
        checkIn: data.checkIn ?? null,
        checkOut: data.checkOut ?? null,
        remarks: data.remarks ?? null,
        source: data.source,
        markedBy: user.id,
        markedAt: now,
      })
      .where(
        and(
          eq(studentAttendance.tenantId, tenant.id),
          eq(studentAttendance.enrollmentId, data.enrollmentId),
          eq(studentAttendance.attendanceDate, data.attendanceDate),
        ),
      )
      .returning();
    return toRow(updated);
  }

  const [createdRow] = await db
    .insert(studentAttendance)
    .values({
      tenantId: tenant.id,
      enrollmentId: data.enrollmentId,
      attendanceDate: data.attendanceDate,
      status: data.status,
      checkIn: data.checkIn ?? null,
      checkOut: data.checkOut ?? null,
      remarks: data.remarks ?? null,
      source: data.source,
      markedBy: user.id,
      markedAt: now,
    })
    .returning();
  return toRow(createdRow);
}

export async function bulkMarkStudentAttendance(
  tenant: TenantContext,
  user: AuthUser,
  data: BulkMarkStudentAttendanceInput,
) {
  const results = [];
  for (const item of data.records) {
    const row = await upsertStudentAttendance(tenant, user, {
      enrollmentId: item.enrollmentId,
      attendanceDate: data.attendanceDate,
      status: item.status,
      checkIn: item.checkIn,
      checkOut: item.checkOut,
      remarks: item.remarks,
      source: data.source,
    });
    results.push(row);
  }
  return results;
}

export async function deleteStudentAttendance(tenant: TenantContext, enrollmentId: bigint, attendanceDate: string) {
  const [deleted] = await db
    .delete(studentAttendance)
    .where(
      and(
        eq(studentAttendance.tenantId, tenant.id),
        eq(studentAttendance.enrollmentId, enrollmentId),
        eq(studentAttendance.attendanceDate, attendanceDate),
      ),
    )
    .returning();
  if (!deleted) throw new HttpError(404, 'Student attendance record not found');
}

// ================================================================ STAFF ATTENDANCE
export async function listStaffAttendance(tenant: TenantContext, q: ListStaffAttendanceInput) {
  const conditions = [eq(staffAttendance.tenantId, tenant.id)];
  if (q.staffId !== undefined) conditions.push(eq(staffAttendance.staffId, q.staffId));
  if (q.dateFrom !== undefined) conditions.push(gte(staffAttendance.attendanceDate, q.dateFrom));
  if (q.dateTo !== undefined) conditions.push(lte(staffAttendance.attendanceDate, q.dateTo));
  if (q.status !== undefined) conditions.push(eq(staffAttendance.status, q.status));
  if (q.source !== undefined) conditions.push(eq(staffAttendance.source, q.source));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(staffAttendance).where(where);
  const rows = await db
    .select()
    .from(staffAttendance)
    .where(where)
    .orderBy(desc(staffAttendance.attendanceDate), asc(staffAttendance.staffId))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getStaffAttendance(tenant: TenantContext, staffId: bigint, attendanceDate: string) {
  const [row] = await db
    .select()
    .from(staffAttendance)
    .where(
      and(
        eq(staffAttendance.tenantId, tenant.id),
        eq(staffAttendance.staffId, staffId),
        eq(staffAttendance.attendanceDate, attendanceDate),
      ),
    )
    .limit(1);
  if (!row) throw new HttpError(404, 'Staff attendance record not found');
  return toRow(row);
}

export async function upsertStaffAttendance(tenant: TenantContext, user: AuthUser, data: UpsertStaffAttendanceInput) {
  await assertStaffInTenant(tenant.id, data.staffId);
  if (data.leaveRequestId != null) {
    const [lr] = await db
      .select({ id: leaveRequests.id, staffId: leaveRequests.staffId })
      .from(leaveRequests)
      .where(and(eq(leaveRequests.id, data.leaveRequestId), eq(leaveRequests.tenantId, tenant.id)))
      .limit(1);
    if (!lr || lr.staffId !== data.staffId) {
      throw new HttpError(400, 'Leave request does not belong to this staff member in this school');
    }
  }

  const workedMinutes = computeWorkedMinutes(data.checkIn, data.checkOut, data.workedMinutes);
  const now = new Date();

  const [existing] = await db
    .select({ id: staffAttendance.staffId })
    .from(staffAttendance)
    .where(
      and(
        eq(staffAttendance.tenantId, tenant.id),
        eq(staffAttendance.staffId, data.staffId),
        eq(staffAttendance.attendanceDate, data.attendanceDate),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(staffAttendance)
      .set({
        status: data.status,
        checkIn: data.checkIn ?? null,
        checkOut: data.checkOut ?? null,
        workedMinutes,
        leaveRequestId: data.leaveRequestId ?? null,
        shiftId: data.shiftId ?? null,
        source: data.source,
        markedBy: user.id,
        markedAt: now,
      })
      .where(
        and(
          eq(staffAttendance.tenantId, tenant.id),
          eq(staffAttendance.staffId, data.staffId),
          eq(staffAttendance.attendanceDate, data.attendanceDate),
        ),
      )
      .returning();
    return toRow(updated);
  }

  const [createdRow] = await db
    .insert(staffAttendance)
    .values({
      tenantId: tenant.id,
      staffId: data.staffId,
      attendanceDate: data.attendanceDate,
      status: data.status,
      checkIn: data.checkIn ?? null,
      checkOut: data.checkOut ?? null,
      workedMinutes,
      leaveRequestId: data.leaveRequestId ?? null,
      shiftId: data.shiftId ?? null,
      source: data.source,
      markedBy: user.id,
      markedAt: now,
    })
    .returning();
  return toRow(createdRow);
}

export async function bulkMarkStaffAttendance(
  tenant: TenantContext,
  user: AuthUser,
  data: BulkMarkStaffAttendanceInput,
) {
  const results = [];
  for (const item of data.records) {
    const row = await upsertStaffAttendance(tenant, user, {
      staffId: item.staffId,
      attendanceDate: data.attendanceDate,
      status: item.status,
      checkIn: item.checkIn,
      checkOut: item.checkOut,
      workedMinutes: item.workedMinutes,
      leaveRequestId: item.leaveRequestId,
      shiftId: item.shiftId,
      source: data.source,
    });
    results.push(row);
  }
  return results;
}

export async function deleteStaffAttendance(tenant: TenantContext, staffId: bigint, attendanceDate: string) {
  const [deleted] = await db
    .delete(staffAttendance)
    .where(
      and(
        eq(staffAttendance.tenantId, tenant.id),
        eq(staffAttendance.staffId, staffId),
        eq(staffAttendance.attendanceDate, attendanceDate),
      ),
    )
    .returning();
  if (!deleted) throw new HttpError(404, 'Staff attendance record not found');
}

// ================================================================ ATTENDANCE RULES
export async function listAttendanceRules(tenant: TenantContext, q: ListAttendanceRulesInput) {
  const conditions = [eq(attendanceRules.tenantId, tenant.id)];
  if (q.audience !== undefined) conditions.push(eq(attendanceRules.audience, q.audience));
  if (q.branchId !== undefined) conditions.push(eq(attendanceRules.branchId, q.branchId));
  if (q.isActive !== undefined) conditions.push(eq(attendanceRules.isActive, q.isActive));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(attendanceRules).where(where);
  const rows = await db
    .select()
    .from(attendanceRules)
    .where(where)
    .orderBy(desc(attendanceRules.effectiveFrom), asc(attendanceRules.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getAttendanceRule(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(attendanceRules)
    .where(and(eq(attendanceRules.id, id), eq(attendanceRules.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Attendance rule not found');
  return toRow(row);
}

export async function createAttendanceRule(tenant: TenantContext, data: CreateAttendanceRuleInput) {
  try {
    const [row] = await db
      .insert(attendanceRules)
      .values({
        tenantId: tenant.id,
        audience: data.audience,
        branchId: data.branchId ?? null,
        name: data.name,
        lateAfter: data.lateAfter ?? null,
        halfDayAfter: data.halfDayAfter ?? null,
        absentAfter: data.absentAfter ?? null,
        minAttendancePercent: fixed2(data.minAttendancePercent) ?? null,
        graceMinutes: data.graceMinutes,
        workingWeekdays: data.workingWeekdays,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo,
        isActive: data.isActive,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in attendance rule');
    throw e;
  }
}

export async function updateAttendanceRule(tenant: TenantContext, id: bigint, data: UpdateAttendanceRuleInput) {
  const [existing] = await db
    .select()
    .from(attendanceRules)
    .where(and(eq(attendanceRules.id, id), eq(attendanceRules.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Attendance rule not found');

  const from = data.effectiveFrom ?? existing.effectiveFrom;
  const to = data.effectiveTo ?? existing.effectiveTo;
  if (to < from) throw new HttpError(400, 'effectiveTo must be on or after effectiveFrom');

  const patch: Partial<typeof attendanceRules.$inferInsert> = {};
  if (data.audience !== undefined) patch.audience = data.audience;
  if (data.branchId !== undefined) patch.branchId = data.branchId;
  if (data.name !== undefined) patch.name = data.name;
  if (data.lateAfter !== undefined) patch.lateAfter = data.lateAfter;
  if (data.halfDayAfter !== undefined) patch.halfDayAfter = data.halfDayAfter;
  if (data.absentAfter !== undefined) patch.absentAfter = data.absentAfter;
  if (data.minAttendancePercent !== undefined) patch.minAttendancePercent = fixed2(data.minAttendancePercent);
  if (data.graceMinutes !== undefined) patch.graceMinutes = data.graceMinutes;
  if (data.workingWeekdays !== undefined) patch.workingWeekdays = data.workingWeekdays;
  if (data.effectiveFrom !== undefined) patch.effectiveFrom = data.effectiveFrom;
  if (data.effectiveTo !== undefined) patch.effectiveTo = data.effectiveTo;
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  const [updated] = await db
    .update(attendanceRules)
    .set(patch)
    .where(and(eq(attendanceRules.id, id), eq(attendanceRules.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function deleteAttendanceRule(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(attendanceRules)
    .where(and(eq(attendanceRules.id, id), eq(attendanceRules.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Attendance rule not found');
}

// ================================================================ ACADEMIC CALENDAR EVENTS (incl. Holidays)
export async function listCalendarEvents(tenant: TenantContext, q: ListCalendarEventsInput) {
  const conditions = [eq(academicCalendarEvents.tenantId, tenant.id)];
  if (q.eventType !== undefined) conditions.push(eq(academicCalendarEvents.eventType, q.eventType));
  if (q.audience !== undefined) conditions.push(eq(academicCalendarEvents.audience, q.audience));
  if (q.academicYearId !== undefined) conditions.push(eq(academicCalendarEvents.academicYearId, q.academicYearId));
  if (q.branchId !== undefined) conditions.push(eq(academicCalendarEvents.branchId, q.branchId));
  if (q.classId !== undefined) conditions.push(eq(academicCalendarEvents.classId, q.classId));
  if (q.from !== undefined) conditions.push(gte(academicCalendarEvents.endsAt, q.from));
  if (q.to !== undefined) conditions.push(lte(academicCalendarEvents.startsAt, q.to));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(academicCalendarEvents.title, pattern), ilike(academicCalendarEvents.description, pattern));
    if (searchCond) conditions.push(searchCond);
  }

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(academicCalendarEvents).where(where);
  const rows = await db
    .select()
    .from(academicCalendarEvents)
    .where(where)
    .orderBy(asc(academicCalendarEvents.startsAt), asc(academicCalendarEvents.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getCalendarEvent(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(academicCalendarEvents)
    .where(and(eq(academicCalendarEvents.id, id), eq(academicCalendarEvents.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Calendar event not found');
  return toRow(row);
}

export async function createCalendarEvent(tenant: TenantContext, data: CreateCalendarEventInput) {
  if (data.classId != null) await assertClassInTenant(tenant.id, data.classId);
  try {
    const [row] = await db
      .insert(academicCalendarEvents)
      .values({
        tenantId: tenant.id,
        academicYearId: data.academicYearId ?? null,
        branchId: data.branchId ?? null,
        title: data.title,
        description: data.description ?? null,
        eventType: data.eventType,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        allDay: data.allDay,
        audience: data.audience,
        classId: data.classId ?? null,
        location: data.location ?? null,
        color: data.color ?? null,
        notifyVia: data.notifyVia,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in calendar event');
    throw e;
  }
}

export async function updateCalendarEvent(tenant: TenantContext, id: bigint, data: UpdateCalendarEventInput) {
  const [existing] = await db
    .select()
    .from(academicCalendarEvents)
    .where(and(eq(academicCalendarEvents.id, id), eq(academicCalendarEvents.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Calendar event not found');

  if (data.classId != null) await assertClassInTenant(tenant.id, data.classId);
  const startsAt = data.startsAt ?? existing.startsAt;
  const endsAt = data.endsAt ?? existing.endsAt;
  if (endsAt < startsAt) throw new HttpError(400, 'endsAt must be on or after startsAt');

  const patch: Partial<typeof academicCalendarEvents.$inferInsert> = {};
  if (data.academicYearId !== undefined) patch.academicYearId = data.academicYearId;
  if (data.branchId !== undefined) patch.branchId = data.branchId;
  if (data.title !== undefined) patch.title = data.title;
  if (data.description !== undefined) patch.description = data.description;
  if (data.eventType !== undefined) patch.eventType = data.eventType;
  if (data.startsAt !== undefined) patch.startsAt = data.startsAt;
  if (data.endsAt !== undefined) patch.endsAt = data.endsAt;
  if (data.allDay !== undefined) patch.allDay = data.allDay;
  if (data.audience !== undefined) patch.audience = data.audience;
  if (data.classId !== undefined) patch.classId = data.classId;
  if (data.location !== undefined) patch.location = data.location;
  if (data.color !== undefined) patch.color = data.color;
  if (data.notifyVia !== undefined) patch.notifyVia = data.notifyVia;

  const [updated] = await db
    .update(academicCalendarEvents)
    .set(patch)
    .where(and(eq(academicCalendarEvents.id, id), eq(academicCalendarEvents.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function deleteCalendarEvent(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(academicCalendarEvents)
    .where(and(eq(academicCalendarEvents.id, id), eq(academicCalendarEvents.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Calendar event not found');
}

// ================================================================ LEAVE TYPES
export async function listLeaveTypes(tenant: TenantContext, q: ListLeaveTypesInput) {
  const conditions = [eq(leaveTypes.tenantId, tenant.id)];
  if (q.applicableTo !== undefined) conditions.push(eq(leaveTypes.applicableTo, q.applicableTo));
  if (q.isActive !== undefined) conditions.push(eq(leaveTypes.isActive, q.isActive));
  if (q.q) {
    const pattern = `%${q.q}%`;
    const searchCond = or(ilike(leaveTypes.code, pattern), ilike(leaveTypes.name, pattern));
    if (searchCond) conditions.push(searchCond);
  }

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(leaveTypes).where(where);
  const rows = await db
    .select()
    .from(leaveTypes)
    .where(where)
    .orderBy(asc(leaveTypes.name), asc(leaveTypes.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getLeaveType(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Leave type not found');
  return toRow(row);
}

export async function createLeaveType(tenant: TenantContext, data: CreateLeaveTypeInput) {
  try {
    const [row] = await db
      .insert(leaveTypes)
      .values({
        tenantId: tenant.id,
        code: data.code,
        name: data.name,
        isPaid: data.isPaid,
        annualQuota: fixed1(data.annualQuota) ?? null,
        maxConsecutiveDays: data.maxConsecutiveDays ?? null,
        requiresDocument: data.requiresDocument,
        carryForward: data.carryForward ?? null,
        carryForwardLimit: fixed1(data.carryForwardLimit) ?? null,
        applicableTo: data.applicableTo,
        leaveCategory: data.leaveCategory,
        accrualBasis: data.accrualBasis,
        isActive: data.isActive,
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A leave type with this code already exists');
    throw e;
  }
}

export async function updateLeaveType(tenant: TenantContext, id: bigint, data: UpdateLeaveTypeInput) {
  const [existing] = await db
    .select({ id: leaveTypes.id })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Leave type not found');

  const patch: Partial<typeof leaveTypes.$inferInsert> = {};
  if (data.code !== undefined) patch.code = data.code;
  if (data.name !== undefined) patch.name = data.name;
  if (data.isPaid !== undefined) patch.isPaid = data.isPaid;
  if (data.annualQuota !== undefined) patch.annualQuota = fixed1(data.annualQuota);
  if (data.maxConsecutiveDays !== undefined) patch.maxConsecutiveDays = data.maxConsecutiveDays;
  if (data.requiresDocument !== undefined) patch.requiresDocument = data.requiresDocument;
  if (data.carryForward !== undefined) patch.carryForward = data.carryForward;
  if (data.carryForwardLimit !== undefined) patch.carryForwardLimit = fixed1(data.carryForwardLimit);
  if (data.applicableTo !== undefined) patch.applicableTo = data.applicableTo;
  if (data.leaveCategory !== undefined) patch.leaveCategory = data.leaveCategory;
  if (data.accrualBasis !== undefined) patch.accrualBasis = data.accrualBasis;
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  try {
    const [updated] = await db
      .update(leaveTypes)
      .set(patch)
      .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'A leave type with this code already exists');
    throw e;
  }
}

export async function deleteLeaveType(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(leaveTypes)
    .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Leave type not found');
}

// ================================================================ LEAVE REQUESTS
export async function listLeaveRequests(tenant: TenantContext, user: AuthUser, q: ListLeaveRequestsInput) {
  const scope = await resolveStudentScope(tenant, user.id, 'leaves.view');
  const scopeCond = studentScopeCondition(leaveRequests.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const conditions = [eq(leaveRequests.tenantId, tenant.id)];
  if (scopeCond) conditions.push(scopeCond);
  if (q.studentId !== undefined) conditions.push(eq(leaveRequests.studentId, q.studentId));
  if (q.staffId !== undefined) conditions.push(eq(leaveRequests.staffId, q.staffId));
  if (q.leaveTypeId !== undefined) conditions.push(eq(leaveRequests.leaveTypeId, q.leaveTypeId));
  if (q.status !== undefined) conditions.push(eq(leaveRequests.status, q.status));
  if (q.fromDate !== undefined) conditions.push(gte(leaveRequests.toDate, q.fromDate));
  if (q.toDate !== undefined) conditions.push(lte(leaveRequests.fromDate, q.toDate));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(leaveRequests).where(where);
  const rows = await db
    .select()
    .from(leaveRequests)
    .where(where)
    .orderBy(desc(leaveRequests.createdAt), desc(leaveRequests.id))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getLeaveRequest(tenant: TenantContext, user: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, user.id, 'leaves.view');
  const [row] = await db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Leave request not found');
  assertStudentReadable(scope, row.studentId, 'Leave request not found');
  return toRow(row);
}

export async function createLeaveRequest(tenant: TenantContext, user: AuthUser, data: CreateLeaveRequestInput) {
  const scope = await resolveStudentScope(tenant, user.id, 'leaves.create', 'leaves.manage');
  if (scope.scoped) {
    if (data.staffId != null) {
      throw new HttpError(403, 'Students and parents cannot submit staff leave requests');
    }
    assertStudentWritable(scope, data.studentId);
  }

  const isStudent = data.studentId != null;
  if (data.studentId != null) await assertStudentInTenant(tenant.id, data.studentId);
  if (data.staffId != null) await assertStaffInTenant(tenant.id, data.staffId);

  if (data.leaveTypeId != null) {
    const [lt] = await db
      .select()
      .from(leaveTypes)
      .where(and(eq(leaveTypes.id, data.leaveTypeId), eq(leaveTypes.tenantId, tenant.id)))
      .limit(1);
    if (!lt || !lt.isActive) throw new HttpError(400, 'Leave type not found or inactive');
    if (isStudent && lt.applicableTo === 'staff') {
      throw new HttpError(400, 'This leave type is only applicable to staff');
    }
    if (!isStudent && lt.applicableTo === 'student') {
      throw new HttpError(400, 'This leave type is only applicable to students');
    }
    if (lt.requiresDocument && data.documentFileId == null) {
      throw new HttpError(400, 'Supporting document (documentFileId) is required for this leave type');
    }
    if (lt.maxConsecutiveDays != null && data.days > lt.maxConsecutiveDays) {
      throw new HttpError(400, `Leave days exceed maxConsecutiveDays (${lt.maxConsecutiveDays})`);
    }
  }

  try {
    const [row] = await db
      .insert(leaveRequests)
      .values({
        tenantId: tenant.id,
        studentId: data.studentId ?? null,
        staffId: data.staffId ?? null,
        leaveTypeId: data.leaveTypeId ?? null,
        requestedByUserId: user.id,
        fromDate: data.fromDate,
        toDate: data.toDate,
        days: data.days.toFixed(1),
        durationType: data.durationType,
        reason: data.reason,
        documentFileId: data.documentFileId ?? null,
        status: 'pending',
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in leave request');
    throw e;
  }
}

export async function updateLeaveRequest(
  tenant: TenantContext,
  user: AuthUser,
  id: bigint,
  data: UpdateLeaveRequestInput,
) {
  const scope = await resolveStudentScope(tenant, user.id, 'leaves.edit', 'leaves.manage');
  const [existing] = await db
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
    .limit(1);
  if (!existing) throw new HttpError(404, 'Leave request not found');
  assertStudentReadable(scope, existing.studentId, 'Leave request not found');
  if (existing.status !== 'pending') {
    throw new HttpError(409, 'Only pending leave requests can be edited');
  }

  const fromDate = data.fromDate ?? existing.fromDate;
  const toDate = data.toDate ?? existing.toDate;
  if (toDate < fromDate) throw new HttpError(400, 'toDate must be on or after fromDate');

  const patch: Partial<typeof leaveRequests.$inferInsert> = {};
  if (data.leaveTypeId !== undefined) patch.leaveTypeId = data.leaveTypeId;
  if (data.fromDate !== undefined) patch.fromDate = data.fromDate;
  if (data.toDate !== undefined) patch.toDate = data.toDate;
  if (data.days !== undefined) patch.days = data.days.toFixed(1);
  if (data.durationType !== undefined) patch.durationType = data.durationType;
  if (data.reason !== undefined) patch.reason = data.reason;
  if (data.documentFileId !== undefined) patch.documentFileId = data.documentFileId;

  const [updated] = await db
    .update(leaveRequests)
    .set(patch)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
    .returning();
  return toRow(updated);
}

export async function decideLeaveRequest(
  tenant: TenantContext,
  user: AuthUser,
  id: bigint,
  data: DecideLeaveRequestInput,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
      .limit(1);
    if (!existing) throw new HttpError(404, 'Leave request not found');
    if (existing.status !== 'pending') {
      throw new HttpError(409, `Leave request is already ${existing.status}`);
    }

    if (data.decision === 'approved' && existing.staffId != null && existing.leaveTypeId != null) {
      const balConditions = [
        eq(leaveBalances.tenantId, tenant.id),
        eq(leaveBalances.staffId, existing.staffId),
        eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
      ];
      if (data.academicYearId !== undefined) {
        balConditions.push(eq(leaveBalances.academicYearId, data.academicYearId));
      }
      const balances = await tx.select().from(leaveBalances).where(and(...balConditions)).limit(2);
      if (balances.length === 1) {
        const bal = balances[0];
        const available = Number(bal.allocated) + Number(bal.carriedForward) - Number(bal.used);
        const requested = Number(existing.days);
        if (requested > available) {
          throw new HttpError(409, `Insufficient leave balance (${available.toFixed(1)} days remaining)`);
        }
        await tx
          .update(leaveBalances)
          .set({ used: (Number(bal.used) + requested).toFixed(1) })
          .where(eq(leaveBalances.id, bal.id));
      }
    }

    const [updated] = await tx
      .update(leaveRequests)
      .set({
        status: data.decision,
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionNotes: data.decisionNotes ?? null,
      })
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  });
}

export async function cancelLeaveRequest(tenant: TenantContext, user: AuthUser, id: bigint) {
  const scope = await resolveStudentScope(tenant, user.id, 'leaves.edit', 'leaves.create', 'leaves.manage');
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
      .limit(1);
    if (!existing) throw new HttpError(404, 'Leave request not found');
    assertStudentReadable(scope, existing.studentId, 'Leave request not found');
    if (existing.status !== 'pending' && existing.status !== 'approved') {
      throw new HttpError(409, `Cannot cancel a ${existing.status} leave request`);
    }

    if (existing.status === 'approved' && existing.staffId != null && existing.leaveTypeId != null) {
      const balances = await tx
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.tenantId, tenant.id),
            eq(leaveBalances.staffId, existing.staffId),
            eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
          ),
        )
        .limit(2);
      if (balances.length === 1) {
        const bal = balances[0];
        const nextUsed = Math.max(0, Number(bal.used) - Number(existing.days));
        await tx.update(leaveBalances).set({ used: nextUsed.toFixed(1) }).where(eq(leaveBalances.id, bal.id));
      }
    }

    const [updated] = await tx
      .update(leaveRequests)
      .set({ status: 'cancelled' })
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  });
}

// ================================================================ LEAVE BALANCES
export async function listLeaveBalances(tenant: TenantContext, q: ListLeaveBalancesInput) {
  const conditions = [eq(leaveBalances.tenantId, tenant.id)];
  if (q.staffId !== undefined) conditions.push(eq(leaveBalances.staffId, q.staffId));
  if (q.leaveTypeId !== undefined) conditions.push(eq(leaveBalances.leaveTypeId, q.leaveTypeId));
  if (q.academicYearId !== undefined) conditions.push(eq(leaveBalances.academicYearId, q.academicYearId));

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(leaveBalances).where(where);
  const rows = await db
    .select()
    .from(leaveBalances)
    .where(where)
    .orderBy(asc(leaveBalances.staffId), asc(leaveBalances.leaveTypeId))
    .limit(q.limit)
    .offset((q.page - 1) * q.limit);

  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, Number(total)) };
}

export async function getLeaveBalance(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(leaveBalances)
    .where(and(eq(leaveBalances.id, id), eq(leaveBalances.tenantId, tenant.id)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Leave balance not found');
  return toRow(row);
}

export async function upsertLeaveBalance(tenant: TenantContext, data: UpsertLeaveBalanceInput) {
  await assertStaffInTenant(tenant.id, data.staffId);
  const [lt] = await db
    .select({ id: leaveTypes.id })
    .from(leaveTypes)
    .where(and(eq(leaveTypes.id, data.leaveTypeId), eq(leaveTypes.tenantId, tenant.id)))
    .limit(1);
  if (!lt) throw new HttpError(400, 'Leave type not found in this school');

  const [existing] = await db
    .select({ id: leaveBalances.id })
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.tenantId, tenant.id),
        eq(leaveBalances.staffId, data.staffId),
        eq(leaveBalances.leaveTypeId, data.leaveTypeId),
        eq(leaveBalances.academicYearId, data.academicYearId),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(leaveBalances)
      .set({
        allocated: data.allocated.toFixed(1),
        used: data.used.toFixed(1),
        carriedForward: data.carriedForward.toFixed(1),
      })
      .where(and(eq(leaveBalances.id, existing.id), eq(leaveBalances.tenantId, tenant.id)))
      .returning();
    return toRow(updated);
  }

  try {
    const [createdRow] = await db
      .insert(leaveBalances)
      .values({
        tenantId: tenant.id,
        staffId: data.staffId,
        leaveTypeId: data.leaveTypeId,
        academicYearId: data.academicYearId,
        allocated: data.allocated.toFixed(1),
        used: data.used.toFixed(1),
        carriedForward: data.carriedForward.toFixed(1),
      })
      .returning();
    return toRow(createdRow);
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new HttpError(400, 'Invalid reference in leave balance');
    throw e;
  }
}

export async function updateLeaveBalance(tenant: TenantContext, id: bigint, data: UpdateLeaveBalanceInput) {
  const patch: Partial<typeof leaveBalances.$inferInsert> = {};
  if (data.allocated !== undefined) patch.allocated = data.allocated.toFixed(1);
  if (data.used !== undefined) patch.used = data.used.toFixed(1);
  if (data.carriedForward !== undefined) patch.carriedForward = data.carriedForward.toFixed(1);

  const [updated] = await db
    .update(leaveBalances)
    .set(patch)
    .where(and(eq(leaveBalances.id, id), eq(leaveBalances.tenantId, tenant.id)))
    .returning();
  if (!updated) throw new HttpError(404, 'Leave balance not found');
  return toRow(updated);
}

export async function deleteLeaveBalance(tenant: TenantContext, id: bigint) {
  const [deleted] = await db
    .delete(leaveBalances)
    .where(and(eq(leaveBalances.id, id), eq(leaveBalances.tenantId, tenant.id)))
    .returning();
  if (!deleted) throw new HttpError(404, 'Leave balance not found');
}
