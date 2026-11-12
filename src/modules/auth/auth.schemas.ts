import { z } from 'zod';

export const USER_TYPES = ['student', 'guardian', 'staff', 'admin', 'owner'] as const;
export const USER_STATUSES = ['active', 'invited', 'suspended', 'deleted'] as const;

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(50, 'Username must not exceed 50 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain only letters, digits, dots, underscores and hyphens')
  .toLowerCase();

const id = z.coerce.bigint().positive();

// A zod schema describes what valid input looks like. .strict() rejects unknown fields.
// Fill in each schema, then the matching TypeScript type below is generated from it.

export const signupSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Name must be at least 2 characters').max(120, 'Name must not exceed 120 characters'),
    email: z.string().trim().email('Invalid email address format').max(254, 'Email address must not exceed 254 characters').toLowerCase(),
    username: usernameSchema.optional(),
    phone: z.string().trim().min(1).max(20).optional(),
    password: z.string().min(10, 'Password must be at least 10 characters').max(128, 'Password must not exceed 128 characters'),
    userType: z.enum(USER_TYPES).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    languageId: id.optional(),
    avatarFileId: id.optional(),
    preferences: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().email('Invalid email address format').max(254, 'Email address must not exceed 254 characters').toLowerCase().optional(),
    username: usernameSchema.optional(),
    password: z.string().min(1, 'Password is required').max(128, 'Password must not exceed 128 characters'), // min 1: never reject an existing password at login
    organization: z.string().trim().max(60, 'Organization must not exceed 60 characters').optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.username), {
    message: 'Email or username is required',
    path: ['email'],
  });

// (given) used by POST /auth/switch-organization in C10
export const switchOrganizationSchema = z
  .object({ organization: z.string().trim().min(1).max(60) })
  .strict();

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
