import { z } from 'zod';

// SHOULD-level (role editing). Skip these three until the MUST parts work.

// TODO: code         string matching /^[a-z][a-z0-9_]{2,40}$/ and not 'owner'
//       name         string, trim, 2-120
//       description  OPTIONAL string, max 300
//       permissions  array of strings (permission codes), max 200
export const createRoleSchema = z.object({}).strict();

// TODO: name OPTIONAL, description OPTIONAL, permissions OPTIONAL (same rules as above)
export const updateRoleSchema = z.object({}).strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
