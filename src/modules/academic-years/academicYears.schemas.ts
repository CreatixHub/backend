import { z } from 'zod';

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

const name = z.string().trim().min(2).max(20);

export const createAcademicYearSchema = z
  .object({
    name, // "2026-27"
    startsOn: isoDate,
    endsOn: isoDate,
    isCurrent: z.boolean().optional(), // the school's first year is always made current
  })
  .strict()
  .refine((v) => v.endsOn > v.startsOn, { message: 'The year must end after it starts', path: ['endsOn'] });

export const updateAcademicYearSchema = z
  .object({
    name: name.optional(),
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
    // Only `true` is accepted: to stop a year being current, make another year current instead
    // (a school always keeps exactly one current year).
    isCurrent: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type CreateAcademicYearInput = z.infer<typeof createAcademicYearSchema>;
export type UpdateAcademicYearInput = z.infer<typeof updateAcademicYearSchema>;
