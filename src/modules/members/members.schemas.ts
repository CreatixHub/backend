import { z } from 'zod';
import { USER_TYPES } from '../auth/auth.schemas';

const roleCodes = z.array(z.string().trim().min(1).max(60)).min(1).max(5);
const id = z.coerce.bigint().positive();
const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(50, 'Username must not exceed 50 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain only letters, digits, dots, underscores and hyphens')
  .toLowerCase();

export const listMembersSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1), // query strings are text: coerce turns "2" into 2
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const addMemberSchema = z
  .object({
    email: z.string().trim().email().max(254).toLowerCase(),
    username: usernameSchema.optional(),
    phone: z.string().trim().min(1).max(20).optional(),
    fullName: z.string().trim().min(2).max(120).optional(), // required only when the person has no account yet
    password: z.string().min(10).max(128).optional(), // required for new non-invited accounts
    invite: z.boolean().optional(), // true creates an invited account without a password yet
    userType: z.enum(USER_TYPES).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    languageId: id.optional(),
    mustChangePassword: z.boolean().optional(),
    roles: roleCodes,
  })
  .strict();

export const updateMemberSchema = z
  .object({
    status: z.enum(['active', 'suspended']).optional(),
    roles: roleCodes.optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.roles !== undefined, 'Nothing to change');

export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
