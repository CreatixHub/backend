import { z } from 'zod';

export const HOMEWORK_TYPES = ['assignment', 'project', 'reading', 'practice'] as const;
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export const SUBMISSION_TYPES = ['text', 'file', 'both'] as const;
export const HOMEWORK_STATUSES = ['draft', 'published', 'closed'] as const;
export const SUBMISSION_STATUSES = ['not_submitted', 'submitted', 'late', 'graded'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
// YYYY-MM-DD, and a REAL date (rejects 2026-02-31)
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');
// a moment in time with its timezone, e.g. 2026-11-20T17:00:00+05:30 or 2026-11-20T11:30:00Z
const dateTime = z.string().trim().datetime({ offset: true });

// ---------------------------------------------------------------- homework
const homeworkFields = {
  sectionId: id,
  subjectId: id,
  teacherId: id.optional(), // defaults to the staff member linked to the logged-in user
  academicYearId: id,
  title: text(200),
  description: z.string().trim().max(5000).nullish(),
  homeworkType: z.enum(HOMEWORK_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  durationMinutes: z.number().int().min(1).max(1440).nullish(),
  assignedOn: isoDate,
  dueAt: dateTime,
  maxMarks: z.number().min(0).max(999.99).nullish(),
  submissionRequired: z.boolean().optional(),
  allowLate: z.boolean().optional(),
  latePenaltyPercent: z.number().min(0).max(100).nullish(),
  submissionType: z.enum(SUBMISSION_TYPES).optional(),
};

export const listHomeworkSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(), // searches title and code
    sectionId: id.optional(),
    subjectId: id.optional(),
    teacherId: id.optional(),
    academicYearId: id.optional(),
    status: z.enum(HOMEWORK_STATUSES).optional(),
    homeworkType: z.enum(HOMEWORK_TYPES).optional(),
    dueAfter: dateTime.optional(), // in a URL write the + of +05:30 as %2B, or use a Z time
    dueBefore: dateTime.optional(),
  })
  .strict();

export const createHomeworkSchema = z
  .object(homeworkFields)
  .strict()
  .refine((v) => v.dueAt.slice(0, 10) >= v.assignedOn, {
    message: 'dueAt cannot be before assignedOn',
    path: ['dueAt'],
  })
  .refine((v) => v.latePenaltyPercent == null || v.allowLate === true, {
    message: 'latePenaltyPercent needs allowLate: true',
    path: ['latePenaltyPercent'],
  });

// a homework never moves to another section or year; the status changes through /publish and /close
export const updateHomeworkSchema = z
  .object(homeworkFields)
  .omit({ sectionId: true, academicYearId: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- submissions
export const listSubmissionsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(SUBMISSION_STATUSES).optional(),
  })
  .strict();

export const recordSubmissionSchema = z
  .object({
    enrollmentId: id,
    submittedAt: dateTime.optional(), // defaults to now
    textAnswer: z.string().trim().min(1).max(10000).nullish(),
    fileId: id.nullish(),
    lateReason: text(500).nullish(),
  })
  .strict();

export const gradeSubmissionSchema = z
  .object({
    score: z.number().min(0).max(999.99).nullish(),
    gradeLabel: text(20).nullish(),
    feedback: z.string().trim().max(2000).nullish(),
    resubmissionRequired: z.boolean().optional(), // true = send it back instead of grading it
  })
  .strict()
  .refine((v) => v.resubmissionRequired === true || (v.score !== undefined && v.score !== null), {
    message: 'score is required unless you are asking for a resubmission',
    path: ['score'],
  });

export type ListHomeworkInput = z.infer<typeof listHomeworkSchema>;
export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
export type ListSubmissionsInput = z.infer<typeof listSubmissionsSchema>;
export type RecordSubmissionInput = z.infer<typeof recordSubmissionSchema>;
export type GradeSubmissionInput = z.infer<typeof gradeSubmissionSchema>;