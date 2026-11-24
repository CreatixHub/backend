import { z } from 'zod';

export const PERIOD_STATUSES = ['present', 'absent', 'late', 'excused'] as const;

const id = z.coerce.bigint().positive();

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// Periods of a day (the teacher's own, or every period for someone with attendance.manage).
export const listPeriodsSchema = z
  .object({
    date: isoDate.optional(), // defaults to today in the school's timezone
    classId: id.optional(),
  })
  .strict();

// The class list of one period on one date, with whatever has been marked already.
export const sheetQuerySchema = z.object({ timetableEntryId: id, date: isoDate }).strict();

export const saveSheetSchema = z
  .object({
    timetableEntryId: id,
    date: isoDate,
    marks: z
      .array(
        z
          .object({
            studentId: id,
            status: z.enum(PERIOD_STATUSES),
            remarks: z.string().trim().max(200).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

// History: who was present in which period.
export const listAttendanceSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    studentId: id.optional(),
    classId: id.optional(),
    subjectId: id.optional(),
    timetableEntryId: id.optional(),
    status: z.enum(PERIOD_STATUSES).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
  })
  .strict();

export const summarySchema = z
  .object({ studentId: id, dateFrom: isoDate.optional(), dateTo: isoDate.optional() })
  .strict();

export type ListPeriodsInput = z.infer<typeof listPeriodsSchema>;
export type SheetQueryInput = z.infer<typeof sheetQuerySchema>;
export type SaveSheetInput = z.infer<typeof saveSheetSchema>;
export type ListAttendanceInput = z.infer<typeof listAttendanceSchema>;
export type SummaryInput = z.infer<typeof summarySchema>;