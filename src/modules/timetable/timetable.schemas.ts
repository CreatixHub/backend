import { z } from 'zod';

export const ENTRY_STATUSES = ['active', 'inactive'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const clock = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const dayOfWeek = z.number().int().min(1).max(7); // 1 = Monday ... 7 = Sunday
// YYYY-MM-DD, and a REAL date (rejects 2026-02-31)
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

const nonEmpty = (v: object) => Object.keys(v).length > 0;

// ---------------------------------------------------------------- time slots
const timeSlotFields = {
  name: text(40), // "Period 1", "Lunch"
  sequence: z.number().int().min(1).max(30), // order within the day
  startsAt: clock,
  endsAt: clock,
  isBreak: z.boolean().optional(),
  isActive: z.boolean().optional(),
};

export const listTimeSlotsSchema = z
  .object({ isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() })
  .strict();

export const createTimeSlotSchema = z
  .object(timeSlotFields)
  .strict()
  .refine((v) => v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

export const updateTimeSlotSchema = z.object(timeSlotFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- section teachers
export const listSectionTeachersSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    sectionId: id.optional(),
    teacherId: id.optional(),
    academicYearId: id.optional(),
  })
  .strict();

export const createSectionTeacherSchema = z
  .object({ sectionId: id, subjectId: id, academicYearId: id, teacherId: id })
  .strict();

export const updateSectionTeacherSchema = z.object({ teacherId: id }).strict();

// ---------------------------------------------------------------- timetable entries
const entryFields = {
  sectionId: id,
  subjectId: id,
  teacherId: id.optional(), // taken from section_teachers when left out
  timeSlotId: id,
  classroomId: id.nullish(),
  dayOfWeek,
  academicYearId: id,
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullish(),
};

export const listEntriesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    sectionId: id.optional(),
    teacherId: id.optional(),
    classroomId: id.optional(),
    timeSlotId: id.optional(),
    academicYearId: id.optional(),
    dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
    status: z.enum(ENTRY_STATUSES).optional(),
    onDate: isoDate.optional(), // only entries that are in effect on this date
  })
  .strict();

export const createEntrySchema = z
  .object(entryFields)
  .strict()
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, {
    message: 'effectiveTo cannot be before effectiveFrom',
    path: ['effectiveTo'],
  });

// the section and academic year of an entry never change: make a new entry instead
export const updateEntrySchema = z
  .object(entryFields)
  .omit({ sectionId: true, academicYearId: true })
  .partial()
  .extend({ status: z.enum(ENTRY_STATUSES).optional() })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export type ListTimeSlotsInput = z.infer<typeof listTimeSlotsSchema>;
export type CreateTimeSlotInput = z.infer<typeof createTimeSlotSchema>;
export type UpdateTimeSlotInput = z.infer<typeof updateTimeSlotSchema>;
export type ListSectionTeachersInput = z.infer<typeof listSectionTeachersSchema>;
export type CreateSectionTeacherInput = z.infer<typeof createSectionTeacherSchema>;
export type UpdateSectionTeacherInput = z.infer<typeof updateSectionTeacherSchema>;
export type ListEntriesInput = z.infer<typeof listEntriesSchema>;
export type CreateEntryInput = z.infer<typeof createEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;