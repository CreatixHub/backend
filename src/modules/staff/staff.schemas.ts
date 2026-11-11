import { z } from 'zod';

export const STAFF_TYPES = ['teaching', 'non_teaching'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'visiting'] as const;
export const STAFF_STATUSES = ['active', 'on_leave', 'suspended', 'left'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
// YYYY-MM-DD, and a REAL date (rejects 2026-02-31)
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// Every field a client may send. null clears an optional field on update.
const staffFields = {
  employeeNo: text(30).optional(), // generated (EMP-0001, ...) when omitted
  userId: id.nullish(), // the login account, if this person has one
  staffType: z.enum(STAFF_TYPES),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  departmentId: id.nullish(),
  designationId: id.nullish(),
  reportsToId: id.nullish(),

  firstName: text(60),
  lastName: text(60).nullish(),
  dob: isoDate.nullish(),
  gender: text(20).nullish(),
  bloodGroup: text(5).nullish(),
  maritalStatus: text(20).nullish(),
  fatherName: text(120).nullish(),
  motherTongueId: id.nullish(),

  email: z.string().trim().email().max(254).toLowerCase().nullish(),
  phone: text(20).nullish(),
  altPhone: text(20).nullish(),

  addressLine1: text(200).nullish(),
  addressLine2: text(200).nullish(),
  cityId: id.nullish(),
  postalCode: text(12).nullish(),
  permanentAddressSame: z.boolean().optional(),
  permanentAddressLine1: text(200).nullish(),
  permanentAddressLine2: text(200).nullish(),
  permanentCityId: id.nullish(),
  permanentPostalCode: text(12).nullish(),

  joinedOn: isoDate,
  probationEndsOn: isoDate.nullish(),
  confirmedOn: isoDate.nullish(),

  qualification: text(200).nullish(),
  experienceYears: z.number().min(0).max(80).nullish(),

  // Sensitive: sent as plain text over HTTPS, stored ENCRYPTED, never returned.
  nationalId: text(50).nullish(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').nullish(),
  bankAccountNumber: z.string().trim().regex(/^\d{6,20}$/, 'Digits only, 6 to 20').nullish(),

  epfNo: text(30).nullish(),
  bankAccountName: text(120).nullish(),
  bankName: text(120).nullish(),
  bankBranch: text(120).nullish(),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC').nullish(),
  bankMicr: z.string().trim().regex(/^\d{9}$/, 'MICR is 9 digits').nullish(),

  emergencyContactName: text(120).nullish(),
  emergencyContactPhone: text(20).nullish(),
  photoFileId: id.nullish(),
  socialLinks: z.record(z.string().trim().min(1).max(30), z.string().trim().url().max(300)).optional(),
};

export const listStaffSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(), // searches name, employee no, email
    staffType: z.enum(STAFF_TYPES).optional(),
    status: z.enum(STAFF_STATUSES).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  })
  .strict();

export const createStaffSchema = z.object(staffFields).strict();

export const updateStaffSchema = z
  .object(staffFields)
  .partial()
  .extend({
    status: z.enum(STAFF_STATUSES).optional(),
    leftOn: isoDate.nullish(),
    leftReason: text(300).nullish(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export type ListStaffInput = z.infer<typeof listStaffSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;