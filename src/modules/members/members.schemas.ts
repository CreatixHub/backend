import { z } from 'zod';

const roleCodes = z.array(z.string().trim().min(1).max(60)).min(1).max(5);

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
    fullName: z.string().trim().min(2).max(120).optional(), // required only when the person has no account yet
    password: z.string().min(10).max(128).optional(), // required only when the person has no account yet
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
