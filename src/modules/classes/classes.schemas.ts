import { z } from 'zod';

export const CLASS_STATUSES = ['active', 'inactive'] as const;
export const SHIFTS = ['morning', 'afternoon', 'evening'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------- classes
const classFields = {
  gradeLevel: z.number().int().min(0).max(20), // numeric order for sorting, e.g. 1-12
  name: text(60), // e.g. "Grade 10"
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,20}$/, 'Code: up to 20 letters, digits, - or _'),
  stream: text(40).nullish(), // Science / Commerce / Arts
  category: text(40).nullish(),
  displayOrder: z.number().int().min(0).max(1000).optional(),
  status: z.enum(CLASS_STATUSES).optional(),
};

export const listClassesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(), // searches name and code
    status: z.enum(CLASS_STATUSES).optional(),
  })
  .strict();

export const createClassSchema = z.object(classFields).strict();

export const updateClassSchema = z
  .object(classFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

// ---------------------------------------------------------------- sections
const sectionFields = {
  classId: id,
  name: text(20), // e.g. "A"
  capacity: z.number().int().min(1).max(500),
  defaultClassroomId: id.nullish(),
  shift: z.enum(SHIFTS).optional(), // defaults to morning
  medium: text(40).nullish(), // language of instruction
  status: z.enum(CLASS_STATUSES).optional(),
};

export const listSectionsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    classId: id.optional(),
    status: z.enum(CLASS_STATUSES).optional(),
  })
  .strict();

export const createSectionSchema = z.object(sectionFields).strict();

// a section never moves to another class, so classId is not editable
export const updateSectionSchema = z
  .object(sectionFields)
  .omit({ classId: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

// ---------------------------------------------------------------- subjects of a class
const classSubjectItem = z
  .object({
    subjectId: id,
    isElective: z.boolean().default(false),
    periodsPerWeek: z.number().int().min(0).max(60).nullish(),
    displayOrder: z.number().int().min(0).max(1000).default(0),
    examMarks: z.number().min(0).max(10000),
    internalMarks: z.number().min(0).max(10000),
    passMarks: z.number().min(0).max(10000).nullish(),
  })
  .strict()
  .refine((v) => v.passMarks == null || v.passMarks <= v.examMarks + v.internalMarks, {
    message: 'passMarks cannot be more than exam + internal marks',
    path: ['passMarks'],
  });

// PUT replaces the WHOLE list of subjects for the class
export const setClassSubjectsSchema = z
  .object({ subjects: z.array(classSubjectItem).max(40) })
  .strict()
  .refine((v) => new Set(v.subjects.map((s) => s.subjectId)).size === v.subjects.length, 'A subject can only be listed once');

export type ListClassesInput = z.infer<typeof listClassesSchema>;
export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type ListSectionsInput = z.infer<typeof listSectionsSchema>;
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
export type SetClassSubjectsInput = z.infer<typeof setClassSubjectsSchema>;