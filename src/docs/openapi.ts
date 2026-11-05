import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { loginSchema, signupSchema, switchOrganizationSchema } from '../modules/auth/auth.schemas';
import { addMemberSchema, listMembersSchema, updateMemberSchema } from '../modules/members/members.schemas';
import { createOrganizationSchema, updateOrganizationSchema } from '../modules/organizations/organizations.schemas';
import { createRoleSchema, updateRoleSchema } from '../modules/roles/roles.schemas';
import {
  CreatedOrganization, CurrentOrganization, ErrorResponse, Health, Me, Member, Permission, Role, SchoolSummary, SessionData,
  envelope, pagedEnvelope,
} from './schemas';

// One place that describes every endpoint. When you add or change a route, update its entry here.
// Request bodies reuse the REAL zod schemas from each module, so the documented rules cannot drift from the code.

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'The access token from sign-up, sign-in, refresh or switch-organization (data.accessToken). Valid for 15 minutes.',
});

// ---------------------------------------------------------------- small helpers
const json = (schema: z.ZodTypeAny, example?: unknown) => ({
  content: { 'application/json': { schema, ...(example === undefined ? {} : { example }) } },
});
const reply = (description: string, schema: z.ZodTypeAny) => ({ description, ...json(schema) });
const fail = (description: string, message: string, errors?: { field: string; message: string }[]) => ({
  description,
  ...json(ErrorResponse, errors ? { message, errors } : { message }),
});

const E = {
  validation: fail('The request is malformed or breaks a rule. "errors" lists each field.', 'Validation failed', [
    { field: 'password', message: 'Password must be at least 10 characters' },
  ]),
  unauthorized: fail('Not signed in: the access token is missing, invalid or expired, or the account or membership is no longer active.', 'Unauthorized'),
  noPermission: fail('Signed in, but the role does not allow this, or the token has no school yet.', 'You do not have permission to do this'),
  rateLimited: {
    description: 'Too many requests from this address (sign-up and sign-in: 10 a minute; everything else: 100 a minute). Wait a minute.',
    content: { 'text/plain': { schema: z.string() } },
  },
};

const SET_COOKIE = {
  'Set-Cookie': {
    description: 'The refresh token: rt=<random>; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=30 days (+ Secure over https). The browser stores it and sends it back to /api/auth/* by itself. It is never in the JSON body.',
    schema: { type: 'string' as const },
  },
};

const needs = (code: string) => `\n\n**Requires permission:** \`${code}\` in the school the token carries.`;
const bearer = [{ bearerAuth: [] }];
const idParam = (what: string) => z.object({ id: z.string().regex(/^\d{1,18}$/).openapi({ example: '12', description: what }) });

// ---------------------------------------------------------------- Health
registry.registerPath({
  method: 'get', path: '/health', tags: ['Health'], summary: 'Is the API (and its database) up?',
  responses: { 200: reply('Up', envelope('HealthResponse', Health)) },
});

// ---------------------------------------------------------------- Auth
registry.registerPath({
  method: 'post', path: '/auth/signup', tags: ['Auth'], summary: 'Create an account and start a session',
  description: 'Creates the user and signs them in. The new person has **no school yet**: create one with `POST /organizations`, then `POST /auth/switch-organization`. Limited to 10 attempts a minute per address.',
  request: { body: { required: true, ...json(signupSchema, { fullName: 'Alice Owner', email: 'alice@example.test', password: 'Temp-pass-12345' }) } },
  responses: {
    201: { ...reply('Account created. Access token in the body, refresh token in the cookie.', envelope('SignupResponse', SessionData)), headers: SET_COOKIE },
    400: E.validation,
    409: fail('That email already has an account.', 'An account with this email already exists'),
    429: E.rateLimited,
  },
});

registry.registerPath({
  method: 'post', path: '/auth/login', tags: ['Auth'], summary: 'Sign in',
  description: 'Starts a new session (a new "family" of refresh tokens). Without `organization` the person starts in their first active school, or in no school if they have none. Wrong password, unknown email and disabled account all give the **same** 401, so emails cannot be discovered. Limited to 10 attempts a minute per address.',
  request: { body: { required: true, ...json(loginSchema, { email: 'alice@example.test', password: 'Temp-pass-12345', organization: 'green-valley' }) } },
  responses: {
    200: { ...reply('Signed in.', envelope('LoginResponse', SessionData)), headers: SET_COOKIE },
    400: E.validation,
    401: fail('Wrong email or password, or the account is disabled.', 'Invalid email or password'),
    429: E.rateLimited,
  },
});

registry.registerPath({
  method: 'post', path: '/auth/refresh', tags: ['Auth'], summary: 'Swap the refresh cookie for a new access token',
  description: 'No body: the `rt` cookie is the proof. Each refresh token works **once**; the reply carries a new cookie and the old one is spent. The session keeps its school.\n\n- Used again within 10 seconds: `409` (a second tab racing; nothing is revoked).\n- Used again later: the whole login is revoked and the answer is `401` (a copied cookie).\n\nIn Swagger UI this works after you sign in on this page, because the browser keeps the cookie.',
  responses: {
    200: { ...reply('New access token and a new cookie.', envelope('RefreshResponse', SessionData)), headers: SET_COOKIE },
    401: fail('Cookie missing, unknown, expired, revoked, or replayed after the grace period.', 'Unauthorized'),
    409: fail('The same cookie was used moments ago. Do not retry it; use the new one.', 'Session refresh in progress'),
  },
});

registry.registerPath({
  method: 'post', path: '/auth/logout', tags: ['Auth'], summary: 'End the session',
  description: 'Revokes every refresh token of this login and clears the cookie. Always succeeds, even without a cookie. Other logins of the same person (a phone, another laptop) keep working.',
  responses: { 204: { description: 'Logged out. No body.' } },
});

registry.registerPath({
  method: 'get', path: '/auth/me', tags: ['Auth'], summary: 'Who am I, which school, which schools do I belong to?',
  security: bearer,
  responses: {
    200: reply('The signed-in person in the school the token carries (organization is null before a school is chosen).', envelope('MeResponse', Me)),
    401: E.unauthorized,
  },
});

registry.registerPath({
  method: 'post', path: '/auth/switch-organization', tags: ['Auth'], summary: 'Act in another school',
  description: 'Returns a **new** access token whose `tid` is the chosen school, and a new cookie in the same login chain. The person must be an active member. A school that does not exist and a school you are not in give the same 403.',
  security: bearer,
  request: { body: { required: true, ...json(switchOrganizationSchema, { organization: 'green-valley' }) } },
  responses: {
    200: { ...reply('New token for the chosen school.', envelope('SwitchResponse', SessionData)), headers: SET_COOKIE },
    400: E.validation,
    401: E.unauthorized,
    403: fail('Not a member of that school (or it does not exist).', 'You do not have access to this organization'),
  },
});

// ---------------------------------------------------------------- Organizations
registry.registerPath({
  method: 'post', path: '/organizations', tags: ['Organizations'], summary: 'Create a school',
  description: 'Any signed-in person may create a school (20 an hour per address). They become its **owner**, and the school gets its own copy of the 12 default roles. The current token does not change: call `POST /auth/switch-organization` to start acting in it.',
  security: bearer,
  request: { body: { required: true, ...json(createOrganizationSchema, { name: 'Green Valley School', slug: 'green-valley' }) } },
  responses: {
    201: reply('School created.', envelope('CreateOrganizationResponse', CreatedOrganization)),
    400: E.validation,
    401: E.unauthorized,
    409: fail('That slug is taken.', 'An organization with this slug already exists'),
  },
});

registry.registerPath({
  method: 'get', path: '/organizations', tags: ['Organizations'], summary: 'Schools I belong to',
  security: bearer,
  responses: { 200: reply('Every active school of the signed-in person, with their roles in each.', envelope('MyOrganizationsResponse', z.array(SchoolSummary))), 401: E.unauthorized },
});

registry.registerPath({
  method: 'get', path: '/organizations/current', tags: ['Organizations'], summary: 'The school I am acting in',
  description: `Includes the caller's own roles and permissions in it.${needs('organization.view')}`,
  security: bearer,
  responses: { 200: reply('The current school.', envelope('CurrentOrganizationResponse', CurrentOrganization)), 401: E.unauthorized, 403: E.noPermission },
});

registry.registerPath({
  method: 'patch', path: '/organizations/current', tags: ['Organizations'], summary: 'Rename the current school or change its timezone',
  description: `Send only the fields you want to change.${needs('organization.edit')}`,
  security: bearer,
  request: { body: { required: true, ...json(updateOrganizationSchema, { name: 'Green Valley International School' }) } },
  responses: { 200: reply('The updated school.', envelope('UpdateOrganizationResponse', CurrentOrganization)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission },
});

// ---------------------------------------------------------------- Members
registry.registerPath({
  method: 'get', path: '/members', tags: ['Members'], summary: 'List the people in the school',
  description: `Paged. \`meta\` holds page, limit, total and pages. \`q\` searches name and email.${needs('members.view')}`,
  security: bearer,
  request: { query: listMembersSchema },
  responses: { 200: reply('One page of members.', pagedEnvelope('MemberListResponse', Member)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission },
});

registry.registerPath({
  method: 'post', path: '/members', tags: ['Members'], summary: 'Add a person to the school',
  description: `Two cases:\n\n- **The person already has an account:** send \`email\` and \`roles\` only. They are added to this school.\n- **No account yet:** also send \`fullName\` and a temporary \`password\`. The account **and** the membership are created together.\n\nOnly an owner can give the \`owner\` role. Role codes are the school's own (see \`GET /roles\`).${needs('members.create')}`,
  security: bearer,
  request: { body: { required: true, ...json(addMemberSchema, { email: 'bob@example.test', fullName: 'Bob Teacher', password: 'Temp-pass-12345', roles: ['teacher'] }) } },
  responses: {
    201: reply('Member added.', envelope('AddMemberResponse', Member)),
    400: E.validation,
    401: E.unauthorized,
    403: E.noPermission,
    409: fail('Already a member of this school.', 'This person is already a member of this school'),
  },
});

registry.registerPath({
  method: 'patch', path: '/members/{id}', tags: ['Members'], summary: 'Change a member\'s roles or suspend them',
  description: `Suspending takes effect at once: the person's existing tokens stop working for this school. You cannot change yourself, a non-owner cannot change an owner, and a school always keeps at least one active owner.${needs('members.edit')}`,
  security: bearer,
  request: { params: idParam('The member id (membership id) from GET /members'), body: { required: true, ...json(updateMemberSchema, { roles: ['accountant'] }) } },
  responses: {
    200: reply('The updated member.', envelope('UpdateMemberResponse', Member)),
    400: E.validation,
    401: E.unauthorized,
    403: E.noPermission,
    404: fail('No such member in this school (another school\'s members look the same).', 'Member not found'),
  },
});

registry.registerPath({
  method: 'delete', path: '/members/{id}', tags: ['Members'], summary: 'Remove a person from the school',
  description: `Removes the membership only; the person's account stays and may belong to other schools. The same safety rules as editing apply.${needs('members.delete')}`,
  security: bearer,
  request: { params: idParam('The member id (membership id) from GET /members') },
  responses: {
    204: { description: 'Removed. No body.' },
    400: E.validation,
    401: E.unauthorized,
    403: E.noPermission,
    404: fail('No such member in this school.', 'Member not found'),
  },
});

// ---------------------------------------------------------------- Roles and permissions
registry.registerPath({
  method: 'get', path: '/roles', tags: ['Roles and permissions'], summary: 'The school\'s roles',
  description: `Every school has its own copy of the 12 default roles (marked \`isSystem\`) plus any custom roles.${needs('roles.view')}`,
  security: bearer,
  responses: { 200: reply('Roles with their permissions and member counts.', envelope('RoleListResponse', z.array(Role))), 401: E.unauthorized, 403: E.noPermission },
});

registry.registerPath({
  method: 'post', path: '/roles', tags: ['Roles and permissions'], summary: 'Create a custom role',
  description: `\`permissions\` are codes from \`GET /permissions\`; unknown codes are refused.${needs('roles.create')}`,
  security: bearer,
  request: { body: { required: true, ...json(createRoleSchema, { code: 'librarian_plus', name: 'Librarian Plus', permissions: ['dashboard.view', 'students.view'] }) } },
  responses: {
    201: reply('Role created.', envelope('CreateRoleResponse', Role)),
    400: E.validation,
    401: E.unauthorized,
    403: E.noPermission,
    409: fail('That code is already used in this school.', 'A role with this code already exists'),
  },
});

registry.registerPath({
  method: 'patch', path: '/roles/{id}', tags: ['Roles and permissions'], summary: 'Edit a custom role',
  description: `Built-in (system) roles cannot be edited.${needs('roles.edit')}`,
  security: bearer,
  request: { params: idParam('The role id from GET /roles'), body: { required: true, ...json(updateRoleSchema, { name: 'Librarian Plus+', permissions: ['dashboard.view'] }) } },
  responses: {
    200: reply('The updated role.', envelope('UpdateRoleResponse', Role)),
    400: E.validation,
    401: E.unauthorized,
    403: fail('A system role, or the caller lacks the permission.', 'System roles cannot be changed'),
    404: fail('No such role in this school.', 'Role not found'),
  },
});

registry.registerPath({
  method: 'delete', path: '/roles/{id}', tags: ['Roles and permissions'], summary: 'Delete a custom role',
  description: `Only custom roles that nobody holds can be deleted.${needs('roles.delete')}`,
  security: bearer,
  request: { params: idParam('The role id from GET /roles') },
  responses: {
    204: { description: 'Deleted. No body.' },
    400: E.validation,
    401: E.unauthorized,
    403: fail('A system role, or the caller lacks the permission.', 'System roles cannot be deleted'),
    404: fail('No such role in this school.', 'Role not found'),
    409: fail('Someone still holds the role.', 'Role is in use'),
  },
});

registry.registerPath({
  method: 'get', path: '/permissions', tags: ['Roles and permissions'], summary: 'The permission catalogue',
  description: `All 110 permission codes (11 modules x 10 actions), flat and sorted. The same for every school.${needs('roles.view')}`,
  security: bearer,
  responses: { 200: reply('Every permission code.', envelope('PermissionListResponse', z.array(Permission))), 401: E.unauthorized, 403: E.noPermission },
});

// ---------------------------------------------------------------- the document
const DESCRIPTION = `
The API behind the Karkaii School ERP. One person has **one account** and can belong to **many schools** with a different role in each.

## Signing in (the 30-second version)
1. \`POST /auth/signup\` (or \`/auth/login\`). The reply has an **access token** (\`data.accessToken\`) and sets a **refresh cookie** \`rt\`.
2. Click **Authorize** (top right) and paste the access token. Every other endpoint now sends it as \`Authorization: Bearer <token>\`.
3. A new account has no school: \`POST /organizations\`, then \`POST /auth/switch-organization\`, and authorize again with the **new** token.
4. The access token lasts **15 minutes**. When a call answers 401, call \`POST /auth/refresh\` (the browser sends the cookie by itself) and authorize with the new token.

## Conventions
- **Success:** \`{ "success": true, "data": ..., "meta": ... }\` (\`meta\` only on paged lists).
- **Errors:** \`{ "message": "...", "errors": [{ "field": "...", "message": "..." }] }\` (\`errors\` only for validation).
- **Ids** are numbers sent as **strings**, for example \`"12"\`.
- **Permissions:** most endpoints list the permission they need. It is checked against the **school in the token**, on every request.
- **Rate limits:** sign-up and sign-in 10 a minute per address; everything else 100 a minute.
`.trim();

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: { title: 'Karkaii API', version: '0.1.0', description: DESCRIPTION },
    servers: [{ url: '/api', description: 'This server' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth', description: 'Sign up, sign in, sessions, school switching' },
      { name: 'Organizations', description: 'Schools' },
      { name: 'Members', description: 'People in a school' },
      { name: 'Roles and permissions' },
    ],
  });
}
