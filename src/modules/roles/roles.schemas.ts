import { z } from 'zod';

const permissionCodes = z.array(z.string().trim().min(1).max(80)).max(200);

export const createRoleSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, 'code must be 3-41 characters: lowercase letters, digits and underscores').refine((c) => c !== 'owner', 'this code is reserved'),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(300).optional(),
    permissions: permissionCodes,
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    permissions: permissionCodes.optional(),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
