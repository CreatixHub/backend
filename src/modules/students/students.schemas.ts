import { z } from 'zod';

export const STUDENT_STATUSES = ['active', 'inactive', 'alumni', 'transferred_out', 'expelled'] as const;
export const GUARDIAN_RELATIONS = ['father', 'mother', 'guardian', 'other'] as const;
export const DOCUMENT_VERIFIED_STATUSES = ['pending', 'verified', 'rejected'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const emailField = z.string().trim().email().max(254).toLowerCase();
const nonEmpty = (v: object) => Object.keys(v).length > 0;

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// ---------------------------------------------------------------- guardians
const guardianFields = {
  fullName: text(120),
  relation: z.enum(GUARDIAN_RELATIONS),
  phone: text(20),
  altPhone: text(20).nullish(),
  email: emailField.nullish(),
  occupation: text(100).nullish(),
  annualIncome: z.number().min(0).max(9999999999.99).nullish(),
  addressLine1: text(200).nullish(),
  addressLine2: text(200).nullish(),
  cityId: id.nullish(),
  postalCode: text(12).nullish(),
  photoFileId: id.nullish(),
  idProofType: text(40).nullish(),
  idProofNo: text(60).nullish(),
  isEmergencyContact: z.boolean().optional(),
};

export const listGuardiansSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(),
    relation: z.enum(GUARDIAN_RELATIONS).optional(),
    isEmergencyContact: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

export const createGuardianSchema = z.object(guardianFields).strict();

export const updateGuardianSchema = z.object(guardianFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- student houses
const studentHouseFields = {
  name: text(80),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3B82F6')
    .nullish(),
  motto: text(200).nullish(),
  houseMasterId: id.nullish(),
  isActive: z.boolean().optional(),
};

export const listStudentHousesSchema = z
  .object({
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .strict();

export const createStudentHouseSchema = z.object(studentHouseFields).strict();

export const updateStudentHouseSchema = z
  .object(studentHouseFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- students
const studentFields = {
  userId: id.nullish(),
  admissionId: id.nullish(),
  admissionNo: text(30).optional(),
  firstName: text(60),
  lastName: text(60),
  fullName: text(130).nullish(),
  dob: isoDate,
  gender: text(20).nullish(),
  bloodGroup: text(5).nullish(),
  religionId: id.nullish(),
  socialCategory: text(40).nullish(),
  motherTongueId: id.nullish(),
  photoFileId: id.nullish(),

  fatherName: text(120).nullish(),
  fatherPhone: text(20).nullish(),
  fatherEmail: emailField.nullish(),
  fatherOccupation: text(100).nullish(),

  motherName: text(120).nullish(),
  motherPhone: text(20).nullish(),
  motherEmail: emailField.nullish(),
  motherOccupation: text(100).nullish(),

  primaryGuardianId: id.nullish(),
  addressLine1: text(200).nullish(),
  addressLine2: text(200).nullish(),
  cityId: id.nullish(),
  postalCode: text(12).nullish(),

  studentHouseId: id.nullish(),
  admittedOn: isoDate.optional(),
};

const inlineGuardianLink = z
  .object({
    guardianId: id,
    isPrimary: z.boolean().default(false),
    canPickUp: z.boolean().default(false),
  })
  .strict();

export const listStudentsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(),
    status: z.enum(STUDENT_STATUSES).optional(),
    studentHouseId: id.optional(),
    gender: text(20).optional(),
  })
  .strict();

export const createStudentSchema = z
  .object(studentFields)
  .extend({
    status: z.enum(STUDENT_STATUSES).optional(),
    leftOn: isoDate.nullish(),
    leftReason: text(300).nullish(),
    guardians: z.array(inlineGuardianLink).max(10).optional(),
  })
  .strict();

export const updateStudentSchema = z
  .object(studentFields)
  .partial()
  .extend({
    status: z.enum(STUDENT_STATUSES).optional(),
    leftOn: isoDate.nullish(),
    leftReason: text(300).nullish(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const updateStudentStatusSchema = z
  .object({
    status: z.enum(STUDENT_STATUSES),
    leftOn: isoDate.nullish(),
    leftReason: text(300).nullish(),
  })
  .strict();

// ---------------------------------------------------------------- student-guardian associations
export const linkStudentGuardianSchema = z
  .object({
    guardianId: id.optional(),
    guardian: createGuardianSchema.optional(),
    isPrimary: z.boolean().default(false),
    canPickUp: z.boolean().default(false),
  })
  .strict()
  .refine((v) => (v.guardianId !== undefined) !== (v.guardian !== undefined), {
    message: 'Send either guardianId (existing guardian) or guardian (new guardian details), not both',
  });

export const updateStudentGuardianSchema = z
  .object({
    isPrimary: z.boolean().optional(),
    canPickUp: z.boolean().optional(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- student documents
const studentDocumentFields = {
  documentType: text(60),
  fileId: id,
  documentNo: text(80).nullish(),
  issuedOn: isoDate.nullish(),
  expiresOn: isoDate.nullish(),
  remarks: text(500).nullish(),
};

export const createStudentDocumentSchema = z.object(studentDocumentFields).strict();

export const updateStudentDocumentSchema = z
  .object(studentDocumentFields)
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const verifyStudentDocumentSchema = z
  .object({
    verifiedStatus: z.enum(DOCUMENT_VERIFIED_STATUSES),
    remarks: text(500).nullish(),
  })
  .strict();

export type ListGuardiansInput = z.infer<typeof listGuardiansSchema>;
export type CreateGuardianInput = z.infer<typeof createGuardianSchema>;
export type UpdateGuardianInput = z.infer<typeof updateGuardianSchema>;
export type ListStudentHousesInput = z.infer<typeof listStudentHousesSchema>;
export type CreateStudentHouseInput = z.infer<typeof createStudentHouseSchema>;
export type UpdateStudentHouseInput = z.infer<typeof updateStudentHouseSchema>;
export type ListStudentsInput = z.infer<typeof listStudentsSchema>;
export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type UpdateStudentStatusInput = z.infer<typeof updateStudentStatusSchema>;
export type LinkStudentGuardianInput = z.infer<typeof linkStudentGuardianSchema>;
export type UpdateStudentGuardianInput = z.infer<typeof updateStudentGuardianSchema>;
export type CreateStudentDocumentInput = z.infer<typeof createStudentDocumentSchema>;
export type UpdateStudentDocumentInput = z.infer<typeof updateStudentDocumentSchema>;
export type VerifyStudentDocumentInput = z.infer<typeof verifyStudentDocumentSchema>;
