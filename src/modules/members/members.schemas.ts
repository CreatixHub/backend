import { z } from 'zod';

// TODO: page   coerced int >= 1, default 1          (query strings are text: z.coerce.number())
//       limit  coerced int 1-100, default 20
//       q      OPTIONAL string, max 100
export const listMembersSchema = z.object({}).strict();

// TODO: email     valid email, max 254
//       fullName  OPTIONAL string, trim, 2-120
//       password  OPTIONAL string, 10-128
//       roles     array of strings, 1-5 items (role codes)
export const addMemberSchema = z.object({}).strict();

// TODO: status  OPTIONAL enum 'active' | 'suspended'
//       roles   OPTIONAL array of strings, 1-5 items
//       (and require at least one of the two: .refine((v) => v.status !== undefined || v.roles !== undefined, 'nothing to change'))
export const updateMemberSchema = z.object({}).strict();

export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
