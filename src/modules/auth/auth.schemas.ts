import { z } from 'zod';

// A zod schema describes what valid input looks like. .strict() rejects unknown fields.
// Fill in each schema, then the matching TypeScript type below is generated from it.

// The role codes the "Sign in as" dropdown may send. Owner and admin both arrive as "admin".
export const LOGIN_ROLES = [
  'admin', 'teacher', 'accountant', 'receptionist', 'librarian',
  'warden', 'transport_manager', 'nurse', 'security', 'parent', 'student',
] as const;

export const signupSchema = z.object({
  fullName: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name must not exceed 120 characters"),
  email: z.string().trim().email("Invalid email address format").max(254, "Email address must not exceed 254 characters").toLowerCase(),
  password: z.string().min(10, "Password must be at least 10 characters").max(128, "Password must not exceed 128 characters"),
}).strict();

export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address format").max(254, "Email address must not exceed 254 characters").toLowerCase(),
  password: z.string().min(1, "Password is required").max(128, "Password must not exceed 128 characters"), // min 1: never reject an existing password at login
  // optional: which school to start in (slug)
  organization: z.string().trim().min(1).max(60).optional(),
  // optional: "Sign in as". The server checks the person really holds this role.
  role: z.enum(LOGIN_ROLES).optional(),
}).strict();

// (given) used by POST /auth/switch-organization in C10
export const switchOrganizationSchema = z
  .object({ organization: z.string().trim().min(1).max(60) })
  .strict();

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;