import { z } from 'zod';

export const STUDENT_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day', 'excused'] as const;
export const STUDENT_ATTENDANCE_SOURCES = ['manual', 'biometric', 'rfid', 'app'] as const;
export const STAFF_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day', 'on_leave'] as const;
export const ATTENDANCE_RULE_AUDIENCES = ['student', 'staff'] as const;
export const CALENDAR_EVENT_TYPES = ['holiday', 'exam', 'event', 'meeting', 'other'] as const;
export const CALENDAR_AUDIENCES = ['all', 'students', 'staff', 'class'] as const;
export const LEAVE_APPLICABLE_TO = ['staff', 'student', 'both'] as const;
export const LEAVE_ACCRUAL_BASIS = ['annual', 'monthly', 'none'] as const;
export const LEAVE_DURATION_TYPES = ['full_day', 'half_day'] as const;
export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const nonEmpty = (v: object) => Object.keys(v).length > 0;

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

const isoTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM or HH:MM:SS');

const isoDateTime = z.string().datetime({ offset: true }).transform((v) => new Date(v));

// ---------------------------------------------------------------- student_attendance
export const listStudentAttendanceSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    enrollmentId: id.optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    status: z.enum(STUDENT_ATTENDANCE_STATUSES).optional(),
    source: z.enum(STUDENT_ATTENDANCE_SOURCES).optional(),
  })
  .strict();

export const upsertStudentAttendanceSchema = z
  .object({
    enrollmentId: id,
    attendanceDate: isoDate,
    status: z.enum(STUDENT_ATTENDANCE_STATUSES),
    checkIn: isoTime.nullish(),
    checkOut: isoTime.nullish(),
    remarks: text(500).nullish(),
    source: z.enum(STUDENT_ATTENDANCE_SOURCES).default('manual'),
  })
  .strict();

export const bulkMarkStudentAttendanceSchema = z
  .object({
    attendanceDate: isoDate,
    source: z.enum(STUDENT_ATTENDANCE_SOURCES).default('manual'),
    records: z
      .array(
        z
          .object({
            enrollmentId: id,
            status: z.enum(STUDENT_ATTENDANCE_STATUSES),
            checkIn: isoTime.nullish(),
            checkOut: isoTime.nullish(),
            remarks: text(500).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

// ---------------------------------------------------------------- staff_attendance
export const listStaffAttendanceSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    staffId: id.optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    status: z.enum(STAFF_ATTENDANCE_STATUSES).optional(),
    source: text(40).optional(),
  })
  .strict();

export const upsertStaffAttendanceSchema = z
  .object({
    staffId: id,
    attendanceDate: isoDate,
    status: z.enum(STAFF_ATTENDANCE_STATUSES),
    checkIn: isoDateTime.nullish(),
    checkOut: isoDateTime.nullish(),
    workedMinutes: z.number().int().min(0).max(1440).nullish(),
    leaveRequestId: id.nullish(),
    shiftId: id.nullish(),
    source: text(40).default('manual'),
  })
  .strict();

export const bulkMarkStaffAttendanceSchema = z
  .object({
    attendanceDate: isoDate,
    source: text(40).default('manual'),
    records: z
      .array(
        z
          .object({
            staffId: id,
            status: z.enum(STAFF_ATTENDANCE_STATUSES),
            checkIn: isoDateTime.nullish(),
            checkOut: isoDateTime.nullish(),
            workedMinutes: z.number().int().min(0).max(1440).nullish(),
            leaveRequestId: id.nullish(),
            shiftId: id.nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

// ---------------------------------------------------------------- attendance_rules
const attendanceRuleFields = {
  audience: z.enum(ATTENDANCE_RULE_AUDIENCES),
  branchId: id.nullish(),
  name: text(120),
  lateAfter: isoTime.nullish(),
  halfDayAfter: isoTime.nullish(),
  absentAfter: isoTime.nullish(),
  minAttendancePercent: z.number().min(0).max(100).nullish(),
  graceMinutes: z.number().int().min(0).max(240).default(0),
  workingWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  effectiveFrom: isoDate,
  effectiveTo: isoDate,
  isActive: z.boolean().default(true),
};

export const listAttendanceRulesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    audience: z.enum(ATTENDANCE_RULE_AUDIENCES).optional(),
    branchId: id.optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

export const createAttendanceRuleSchema = z
  .object(attendanceRuleFields)
  .strict()
  .refine((v) => v.effectiveTo >= v.effectiveFrom, {
    message: 'effectiveTo must be on or after effectiveFrom',
    path: ['effectiveTo'],
  });

export const updateAttendanceRuleSchema = z
  .object(attendanceRuleFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- academic_calendar_events
const calendarEventFields = {
  academicYearId: id.nullish(),
  branchId: id.nullish(),
  title: text(160),
  description: text(1000).nullish(),
  eventType: z.enum(CALENDAR_EVENT_TYPES),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  allDay: z.boolean().default(false),
  audience: z.enum(CALENDAR_AUDIENCES).default('all'),
  classId: id.nullish(),
  location: text(160).nullish(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3B82F6')
    .nullish(),
  notifyVia: z.array(text(30)).max(10).default([]),
};

export const listCalendarEventsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    eventType: z.enum(CALENDAR_EVENT_TYPES).optional(),
    audience: z.enum(CALENDAR_AUDIENCES).optional(),
    academicYearId: id.optional(),
    branchId: id.optional(),
    classId: id.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createCalendarEventSchema = z
  .object(calendarEventFields)
  .strict()
  .refine((v) => v.endsAt >= v.startsAt, {
    message: 'endsAt must be on or after startsAt',
    path: ['endsAt'],
  });

export const updateCalendarEventSchema = z
  .object(calendarEventFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- leave_types
const leaveTypeFields = {
  code: text(30).transform((s) => s.toUpperCase()),
  name: text(100),
  isPaid: z.boolean().default(true),
  annualQuota: z.number().min(0).max(366).nullish(),
  maxConsecutiveDays: z.number().int().min(1).max(366).nullish(),
  requiresDocument: z.boolean().default(false),
  carryForward: z.boolean().nullish(),
  carryForwardLimit: z.number().min(0).max(366).nullish(),
  applicableTo: z.enum(LEAVE_APPLICABLE_TO),
  leaveCategory: text(40),
  accrualBasis: z.enum(LEAVE_ACCRUAL_BASIS),
  isActive: z.boolean().default(true),
};

export const listLeaveTypesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    applicableTo: z.enum(LEAVE_APPLICABLE_TO).optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const createLeaveTypeSchema = z.object(leaveTypeFields).strict();
export const updateLeaveTypeSchema = z
  .object(leaveTypeFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- leave_requests
export const listLeaveRequestsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    studentId: id.optional(),
    staffId: id.optional(),
    leaveTypeId: id.optional(),
    status: z.enum(LEAVE_REQUEST_STATUSES).optional(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
  })
  .strict();

export const createLeaveRequestSchema = z
  .object({
    studentId: id.nullish(),
    staffId: id.nullish(),
    leaveTypeId: id.nullish(),
    fromDate: isoDate,
    toDate: isoDate,
    days: z.number().positive().max(366),
    durationType: z.enum(LEAVE_DURATION_TYPES).default('full_day'),
    reason: text(1000),
    documentFileId: id.nullish(),
  })
  .strict()
  .refine((v) => Boolean(v.studentId) !== Boolean(v.staffId), {
    message: 'Provide either studentId or staffId (not both)',
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: 'toDate must be on or after fromDate',
    path: ['toDate'],
  });

export const updateLeaveRequestSchema = z
  .object({
    leaveTypeId: id.nullish(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    days: z.number().positive().max(366).optional(),
    durationType: z.enum(LEAVE_DURATION_TYPES).optional(),
    reason: text(1000).optional(),
    documentFileId: id.nullish(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const decideLeaveRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    decisionNotes: text(1000).nullish(),
    academicYearId: id.optional(),
  })
  .strict();

// ---------------------------------------------------------------- leave_balances
export const listLeaveBalancesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    staffId: id.optional(),
    leaveTypeId: id.optional(),
    academicYearId: id.optional(),
  })
  .strict();

export const upsertLeaveBalanceSchema = z
  .object({
    staffId: id,
    leaveTypeId: id,
    academicYearId: id,
    allocated: z.number().min(0).max(366),
    used: z.number().min(0).max(366).default(0),
    carriedForward: z.number().min(0).max(366).default(0),
  })
  .strict();

export const updateLeaveBalanceSchema = z
  .object({
    allocated: z.number().min(0).max(366).optional(),
    used: z.number().min(0).max(366).optional(),
    carriedForward: z.number().min(0).max(366).optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export type ListStudentAttendanceInput = z.infer<typeof listStudentAttendanceSchema>;
export type UpsertStudentAttendanceInput = z.infer<typeof upsertStudentAttendanceSchema>;
export type BulkMarkStudentAttendanceInput = z.infer<typeof bulkMarkStudentAttendanceSchema>;

export type ListStaffAttendanceInput = z.infer<typeof listStaffAttendanceSchema>;
export type UpsertStaffAttendanceInput = z.infer<typeof upsertStaffAttendanceSchema>;
export type BulkMarkStaffAttendanceInput = z.infer<typeof bulkMarkStaffAttendanceSchema>;

export type ListAttendanceRulesInput = z.infer<typeof listAttendanceRulesSchema>;
export type CreateAttendanceRuleInput = z.infer<typeof createAttendanceRuleSchema>;
export type UpdateAttendanceRuleInput = z.infer<typeof updateAttendanceRuleSchema>;

export type ListCalendarEventsInput = z.infer<typeof listCalendarEventsSchema>;
export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;

export type ListLeaveTypesInput = z.infer<typeof listLeaveTypesSchema>;
export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;

export type ListLeaveRequestsInput = z.infer<typeof listLeaveRequestsSchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type UpdateLeaveRequestInput = z.infer<typeof updateLeaveRequestSchema>;
export type DecideLeaveRequestInput = z.infer<typeof decideLeaveRequestSchema>;

export type ListLeaveBalancesInput = z.infer<typeof listLeaveBalancesSchema>;
export type UpsertLeaveBalanceInput = z.infer<typeof upsertLeaveBalanceSchema>;
export type UpdateLeaveBalanceInput = z.infer<typeof updateLeaveBalanceSchema>;
