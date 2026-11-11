import { z } from 'zod';

export const SUBJECT_TYPES = ['core', 'elective', 'co_curricular', 'language'] as const;
export const SUBJECT_STATUSES = ['active', 'inactive'] as const;

const id = z.coerce.bigint().positive();

const subjectFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,20}$/, 'Code: 2 to 20 letters, digits, - or _'),
  name: z.string().trim().min(2).max(100),
  subjectType: z.enum(SUBJECT_TYPES),
  credits: z.number().min(0).max(99.9).nullish(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3B82F6')
    .nullish(),
  departmentId: id.nullish(),
  status: z.enum(SUBJECT_STATUSES).optional(), // defaults to active on create
};

export const listSubjectsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(), // searches code and name
    subjectType: z.enum(SUBJECT_TYPES).optional(),
    status: z.enum(SUBJECT_STATUSES).optional(),
  })
  .strict();

export const createSubjectSchema = z.object(subjectFields).strict();

export const updateSubjectSchema = z
  .object(subjectFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type ListSubjectsInput = z.infer<typeof listSubjectsSchema>;
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;