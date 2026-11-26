import { z } from 'zod';

const id = z.coerce.bigint().positive();

// A class teacher is the teacher in charge of a class (e.g. "Class III").
// Not the same as section_teachers, which says who teaches each SUBJECT of a section.

export const listClassTeachersSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    classId: id.optional(),
    teacherId: id.optional(),
  })
  .strict();

// Assigning to a class that already has a class teacher replaces that teacher.
export const assignClassTeacherSchema = z.object({ classId: id, teacherId: id }).strict();

export const updateClassTeacherSchema = z.object({ teacherId: id }).strict();

export type ListClassTeachersInput = z.infer<typeof listClassTeachersSchema>;
export type AssignClassTeacherInput = z.infer<typeof assignClassTeacherSchema>;
export type UpdateClassTeacherInput = z.infer<typeof updateClassTeacherSchema>;