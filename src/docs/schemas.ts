import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds .openapi() to zod. Call it once, before any schema below is created.
extendZodWithOpenApi(z);

// These schemas exist ONLY to document responses. The server does not run them; the request schemas
// (signupSchema, createRoleSchema ...) are the real ones, imported from each module.
// Keep them in step with what the services return (see toFrontendUser in auth/session.ts, toMember in members.service.ts ...).

// BigInt ids are sent as strings (see lib/bigint.ts).
const id = (example: string) => z.string().openapi({ example, description: 'Numeric id, sent as a string' });

export const ErrorResponse = z
  .object({
    message: z.string(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  })
  .openapi('Error', { description: 'Every error has this shape. "errors" is present for validation problems.' });

export const SchoolSummary = z
  .object({
    id: id('7'),
    slug: z.string().openapi({ example: 'green-valley' }),
    name: z.string().openapi({ example: 'Green Valley School' }),
    roles: z.array(z.string()).openapi({ example: ['owner'], description: 'The caller\'s roles in this school' }),
  })
  .openapi('SchoolSummary');

const FRONTEND_ROLES = [
  'admin', 'teacher', 'accountant', 'librarian', 'receptionist', 'warden', 'transport_manager', 'nurse', 'security', 'parent', 'student',
] as const;

export const ApiUser = z
  .object({
    id: id('8'),
    name: z.string().openapi({ example: 'Alice Owner' }),
    email: z.string().openapi({ example: 'alice@example.test' }),
    role: z
      .enum(FRONTEND_ROLES)
      .nullable()
      .openapi({ description: 'One role for the frontend, derived from the roles in the active school. null while there is no school.' }),
    permissions: z.array(z.string()).openapi({ example: ['*'], description: '["*"] = every permission (owners). [] while there is no school.' }),
    avatar: z.string().nullable(),
    phone: z.string().nullable(),
    organization: z
      .object({ id: id('7'), slug: z.string(), name: z.string(), roles: z.array(z.string()) })
      .nullable()
      .openapi({ description: 'The school this token acts in, or null' }),
  })
  .openapi('User');

export const SessionData = z
  .object({
    accessToken: z.string().openapi({ description: 'JWT, valid for expiresIn seconds. Send as "Authorization: Bearer <token>".' }),
    expiresIn: z.number().int().openapi({ example: 900, description: 'Seconds until the access token expires' }),
    user: ApiUser,
    organizations: z.array(SchoolSummary).openapi({ description: 'Every school this person belongs to' }),
  })
  .openapi('Session');

export const Me = ApiUser.extend({ organizations: z.array(SchoolSummary) }).openapi('Me');

export const CreatedOrganization = z
  .object({ id: id('7'), slug: z.string(), name: z.string(), timezone: z.string().openapi({ example: 'UTC' }), roles: z.array(z.string()).openapi({ example: ['owner'] }) })
  .openapi('CreatedOrganization');

export const CurrentOrganization = z
  .object({
    id: id('7'),
    slug: z.string(),
    name: z.string(),
    timezone: z.string(),
    status: z.string().openapi({ example: 'active' }),
    createdAt: z.string().datetime(),
    myRoles: z.array(z.string()).openapi({ example: ['teacher'] }),
    myPermissions: z.array(z.string()).openapi({ description: 'Sorted permission codes; ["*"] for owners' }),
  })
  .openapi('Organization');

export const Member = z
  .object({
    id: id('12').openapi({ description: 'The MEMBERSHIP id. Use it in /members/{id}.' }),
    userId: id('13'),
    name: z.string().openapi({ example: 'Bob Teacher' }),
    email: z.string().openapi({ example: 'bob@example.test' }),
    phone: z.string().nullable(),
    status: z.enum(['active', 'suspended']),
    roles: z.array(z.string()).openapi({ example: ['teacher'] }),
    createdAt: z.string().datetime(),
  })
  .openapi('Member');

export const PageMeta = z
  .object({ page: z.number().int(), limit: z.number().int(), total: z.number().int(), pages: z.number().int() })
  .openapi('PageMeta');

export const Role = z
  .object({
    id: id('21'),
    code: z.string().openapi({ example: 'teacher' }),
    name: z.string().openapi({ example: 'Teacher' }),
    description: z.string().nullable(),
    isSystem: z.boolean().openapi({ description: 'Built-in roles cannot be edited or deleted' }),
    memberCount: z.number().int().openapi({ description: 'How many people hold this role in the school' }),
    permissions: z.array(z.string()).openapi({ example: ['students.view'], description: '["*"] for the owner role' }),
  })
  .openapi('Role');

export const Permission = z
  .object({ code: z.string().openapi({ example: 'students.view' }), module: z.string().openapi({ example: 'students' }), action: z.string().openapi({ example: 'view' }) })
  .openapi('Permission');

export const Health = z.object({ status: z.literal('ok') }).openapi('Health');

// { success: true, data, meta? } - the envelope the frontend's apiClient expects.
export const envelope = <T extends z.ZodTypeAny>(name: string, data: T) =>
  z.object({ success: z.literal(true), data }).openapi(name);

export const pagedEnvelope = <T extends z.ZodTypeAny>(name: string, item: T) =>
  z.object({ success: z.literal(true), data: z.array(item), meta: PageMeta }).openapi(name);
