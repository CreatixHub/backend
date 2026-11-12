import { z } from 'zod';

export const ADMISSION_STATUSES = [
  'enquiry',
  'applied',
  'document_review',
  'shortlisted',
  'waitlisted',
  'offered',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export const ADMISSION_SOURCES = ['walk_in', 'website', 'referral', 'agent', 'event', 'other'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const emailField = z.string().trim().email().max(254).toLowerCase();

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

const admissionFields = {
  applicationNo: text(30).optional(),
  academicYearId: id,
  classId: id,

  firstName: text(60),
  lastName: text(60),
  dob: isoDate,
  gender: text(20).nullish(),
  email: emailField.nullish(),
  phone: text(20).nullish(),
  bloodGroup: text(5).nullish(),
  religionId: id.nullish(),
  socialCategory: text(40).nullish(),

  fatherName: text(120).nullish(),
  fatherPhone: text(20).nullish(),
  fatherEmail: emailField.nullish(),
  fatherOccupation: text(100).nullish(),

  motherName: text(120).nullish(),
  motherPhone: text(20).nullish(),
  motherEmail: emailField.nullish(),
  motherOccupation: text(100).nullish(),

  guardianName: text(120),
  guardianPhone: text(20),
  guardianEmail: emailField.nullish(),

  previousSchool: text(200).nullish(),
  previousClass: text(60).nullish(),

  addressLine1: text(200).nullish(),
  addressLine2: text(200).nullish(),
  cityId: id.nullish(),
  postalCode: text(12).nullish(),

  appliedOn: isoDate.optional(),
  acknowledgedAt: z.string().datetime({ offset: true }).nullish(),
  decisionOn: isoDate.nullish(),
  decisionNotes: text(1000).nullish(),
  rejectionReason: text(500).nullish(),
  waitlistPosition: z.number().int().min(1).max(32767).nullish(),
  assignedToStaffId: id.nullish(),

  needsTransport: z.boolean().optional(),
  needsHostel: z.boolean().optional(),

  applicationFee: z.number().min(0).max(999999999.99).nullish(),
  feePaid: z.boolean().optional(),
  feePaidOn: isoDate.nullish(),
  feePaymentMethod: text(40).nullish(),

  source: z.enum(ADMISSION_SOURCES),
};

export const listAdmissionsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(),
    status: z.enum(ADMISSION_STATUSES).optional(),
    source: z.enum(ADMISSION_SOURCES).optional(),
    academicYearId: id.optional(),
    classId: id.optional(),
    assignedToStaffId: id.optional(),
    feePaid: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

export const createAdmissionSchema = z
  .object(admissionFields)
  .extend({
    status: z.enum(['enquiry', 'applied', 'document_review', 'shortlisted', 'waitlisted', 'offered']).optional(),
    note: text(1000).nullish(),
  })
  .strict();

export const updateAdmissionSchema = z
  .object(admissionFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const changeAdmissionStatusSchema = z
  .object({
    status: z.enum(ADMISSION_STATUSES),
    note: text(1000).nullish(),
    decisionOn: isoDate.optional(),
    decisionNotes: text(1000).nullish(),
    rejectionReason: text(500).nullish(),
    waitlistPosition: z.number().int().min(1).max(32767).nullish(),
    // used when status === 'accepted' to create the linked student record
    admissionNo: text(30).optional(),
    admittedOn: isoDate.optional(),
    studentHouseId: id.nullish(),
  })
  .strict();

export const acceptAdmissionSchema = z
  .object({
    note: text(1000).nullish(),
    decisionOn: isoDate.optional(),
    decisionNotes: text(1000).nullish(),
    admissionNo: text(30).optional(),
    admittedOn: isoDate.optional(),
    studentHouseId: id.nullish(),
  })
  .strict();

export type ListAdmissionsInput = z.infer<typeof listAdmissionsSchema>;
export type CreateAdmissionInput = z.infer<typeof createAdmissionSchema>;
export type UpdateAdmissionInput = z.infer<typeof updateAdmissionSchema>;
export type ChangeAdmissionStatusInput = z.infer<typeof changeAdmissionStatusSchema>;
export type AcceptAdmissionInput = z.infer<typeof acceptAdmissionSchema>;
