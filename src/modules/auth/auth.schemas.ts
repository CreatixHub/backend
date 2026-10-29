import { z } from 'zod';

// A zod schema describes what valid input looks like. .strict() rejects unknown fields.
// Fill in each schema, then the matching TypeScript type below is generated from it.

// TODO (C6): fullName  string, trim, 2-120
//            email     string, trim, valid email, max 254
//            password  string, 10-128
export const signupSchema = z.object({
  fullName: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name must not exceed 120 characters"),
  email: z.string().trim().email("Invalid email address format").max(254, "Email address must not exceed 254 characters").toLowerCase(),
  password: z.string().min(10, "Password must be at least 10 characters").max(128, "Password must not exceed 128 characters"),
}).strict();

// TODO (C7): email         string, trim, valid email, max 254
//            password      string, 1-128
//            organization  OPTIONAL string, max 60 (a school slug)
export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address format").max(254, "Email address must not exceed 254 characters").toLowerCase(),
  password: z.string().min(1, "Password is required").max(128, "Password must not exceed 128 characters"), // min 1: never reject an existing password at login
  organization: z.string().trim().max(60, "Organization must not exceed 60 characters").optional(),
}).strict();

// (given) used by POST /auth/switch-organization in C10
export const switchOrganizationSchema = z
  .object({ organization: z.string().trim().min(1).max(60) })
  .strict();

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
