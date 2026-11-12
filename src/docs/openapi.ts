import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { loginSchema, signupSchema, switchOrganizationSchema } from '../modules/auth/auth.schemas';
import { addMemberSchema, listMembersSchema, updateMemberSchema } from '../modules/members/members.schemas';
import { createOrganizationSchema, updateOrganizationSchema } from '../modules/organizations/organizations.schemas';
import { createRoleSchema, updateRoleSchema } from '../modules/roles/roles.schemas';
import { createStaffSchema, listStaffSchema, updateStaffSchema } from '../modules/staff/staff.schemas';
import { createSubjectSchema, listSubjectsSchema, updateSubjectSchema } from '../modules/subjects/subjects.schemas';
import {
  createClassSchema, createSectionSchema, listClassesSchema, listSectionsSchema, setClassSubjectsSchema,
  updateClassSchema, updateSectionSchema,
} from '../modules/classes/classes.schemas';
import {
  createEntrySchema, createSectionTeacherSchema, createTimeSlotSchema, listEntriesSchema, listSectionTeachersSchema,
  listTimeSlotsSchema, updateEntrySchema, updateSectionTeacherSchema, updateTimeSlotSchema,
} from '../modules/timetable/timetable.schemas';
import {
  createHomeworkSchema, gradeSubmissionSchema, listHomeworkSchema, listSubmissionsSchema, recordSubmissionSchema,
  updateHomeworkSchema,
} from '../modules/homework/homework.schemas';
import {
  createAssignmentSchema, createDriverSchema, createPickupPointSchema, createRouteSchema, createScheduleSchema,
  createVehicleSchema, listAssignmentsSchema, listDriversSchema, listPickupPointsSchema, listRoutesSchema,
  listSchedulesSchema, listVehiclesSchema, updateAssignmentSchema, updateDriverSchema, updatePickupPointSchema,
  updateRouteSchema, updateScheduleSchema, updateVehicleSchema,
} from '../modules/transport/transport.schemas';
import {
  createAllocationSchema, createAssetSchema, createCategorySchema, createMaintenanceSchema, disposeAssetSchema,
  listAllocationsSchema, listAssetsSchema, listMaintenanceSchema, returnAllocationSchema, updateAllocationSchema,
  updateAssetSchema, updateCategorySchema, updateMaintenanceSchema,
} from '../modules/assets/assets.schemas';
import {
  acceptAdmissionSchema, changeAdmissionStatusSchema, createAdmissionSchema, listAdmissionsSchema,
  updateAdmissionSchema,
} from '../modules/admissions/admissions.schemas';
import {
  createGuardianSchema, createStudentDocumentSchema, createStudentHouseSchema, createStudentSchema,
  linkStudentGuardianSchema, listGuardiansSchema, listStudentHousesSchema, listStudentsSchema,
  updateGuardianSchema, updateStudentDocumentSchema, updateStudentGuardianSchema, updateStudentHouseSchema,
  updateStudentSchema, updateStudentStatusSchema, verifyStudentDocumentSchema,
} from '../modules/students/students.schemas';
import {
  Admission, AdmissionStatusHistoryItem, Asset, AssetAllocation, AssetCategory, AssetMaintenance, ClassRow, ClassSubject, CreatedOrganization,
  CurrentOrganization, Driver, ErrorResponse, Guardian, Health, Homework, HomeworkSubmission, Me, Member, Permission,
  PickupPoint, Role, RouteSchedule, SchoolSummary, Section, SectionTeacher, SessionData, Staff, Student, StudentDocument,
  StudentGuardian, StudentHouse, Subject, TimeSlot, TimetableEntry, TransportAssignment, TransportRoute, Vehicle,
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

// Registers the standard list/get-one/create/update[/delete] shape for one resource in one call.
// Modules 7-13 (Staff through Assets) are almost entirely this shape; the few genuinely different endpoints
// (the classes/subjects mapping, homework publish/close/submissions/grade, asset dispose, allocation return)
// are registered by hand below, the same way Members/Roles always were.
function crud(opts: {
  tag: string;
  base: string; // '/subjects' (no leading /api - servers already has that)
  module: string; // permission prefix, e.g. 'subjects'
  resourceName: string; // singular, lowercase, for summaries: 'subject'
  idDesc: string; // what the :id is, for idParam()
  item: z.ZodTypeAny;
  listQuery?: z.ZodTypeAny;
  paged?: boolean;
  listDescription?: string;
  withGetOne?: boolean;
  createBody?: z.ZodTypeAny;
  createExample?: unknown;
  createDescription?: string;
  conflict?: { description: string; message: string }; // 409 on create, e.g. a duplicate code
  updateBody?: z.ZodTypeAny;
  updateExample?: unknown;
  updateDescription?: string;
  withDelete?: boolean;
  deleteSummary?: string;
  deleteDescription?: string;
}) {
  const { tag, base, module, resourceName, idDesc, item } = opts;
  const notFound = fail(`No such ${resourceName} in this school.`, `${resourceName[0].toUpperCase()}${resourceName.slice(1)} not found`);

  registry.registerPath({
    method: 'get', path: base, tags: [tag], summary: `List ${resourceName}s`,
    description: (opts.listDescription ?? '') + needs(`${module}.view`),
    security: bearer,
    // zod-to-openapi's RouteParameter type is narrower than ZodTypeAny; this helper takes any zod object,
    // which registerPath() itself validates fine at doc-build time regardless of this cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(opts.listQuery ? { request: { query: opts.listQuery as any } } : {}),
    responses: {
      200: reply(`${opts.paged ? 'One page of' : 'Every'} ${resourceName}.`, opts.paged ? pagedEnvelope(`${tag}ListResponse`, item) : envelope(`${tag}ListResponse`, z.array(item))),
      400: E.validation, 401: E.unauthorized, 403: E.noPermission,
    },
  });

  if (opts.withGetOne) {
    registry.registerPath({
      method: 'get', path: `${base}/{id}`, tags: [tag], summary: `Get one ${resourceName}`,
      description: needs(`${module}.view`), security: bearer, request: { params: idParam(idDesc) },
      responses: { 200: reply(`The ${resourceName}.`, envelope(`${tag}Response`, item)), 401: E.unauthorized, 403: E.noPermission, 404: notFound },
    });
  }

  if (opts.createBody) {
    registry.registerPath({
      method: 'post', path: base, tags: [tag], summary: `Create a ${resourceName}`,
      description: (opts.createDescription ?? '') + needs(`${module}.create`), security: bearer,
      request: { body: { required: true, ...json(opts.createBody, opts.createExample) } },
      responses: {
        201: reply(`${resourceName[0].toUpperCase()}${resourceName.slice(1)} created.`, envelope(`Create${tag}Response`, item)),
        400: E.validation, 401: E.unauthorized, 403: E.noPermission,
        ...(opts.conflict ? { 409: fail(opts.conflict.description, opts.conflict.message) } : {}),
      },
    });
  }

  if (opts.updateBody) {
    registry.registerPath({
      method: 'patch', path: `${base}/{id}`, tags: [tag], summary: `Edit a ${resourceName}`,
      description: (opts.updateDescription ?? '') + needs(`${module}.edit`), security: bearer,
      request: { params: idParam(idDesc), body: { required: true, ...json(opts.updateBody, opts.updateExample) } },
      responses: {
        200: reply(`The updated ${resourceName}.`, envelope(`Update${tag}Response`, item)),
        400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: notFound,
      },
    });
  }

  if (opts.withDelete) {
    registry.registerPath({
      method: 'delete', path: `${base}/{id}`, tags: [tag], summary: opts.deleteSummary ?? `Remove a ${resourceName}`,
      description: (opts.deleteDescription ?? '') + needs(`${module}.delete`), security: bearer,
      request: { params: idParam(idDesc) },
      responses: { 204: { description: 'Done. No body.' }, 401: E.unauthorized, 403: E.noPermission, 404: notFound },
    });
  }
}

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
  description: `All 210 permission codes (21 modules x 10 actions), flat and sorted. The same for every school.${needs('roles.view')}`,
  security: bearer,
  responses: { 200: reply('Every permission code.', envelope('PermissionListResponse', z.array(Permission))), 401: E.unauthorized, 403: E.noPermission },
});

// ---------------------------------------------------------------- Staff
crud({
  tag: 'Staff', base: '/staff', module: 'staff', resourceName: 'staff member', idDesc: 'The staff id from GET /staff',
  item: Staff, listQuery: listStaffSchema, paged: true,
  listDescription: 'Paged. `q` searches name, employee number and email.',
  withGetOne: true,
  createBody: createStaffSchema, createDescription: 'National ID, PAN and bank account are encrypted at rest and never returned - the response only says whether one is on file.',
  createExample: { firstName: 'Priya', lastName: 'Nair', staffType: 'teaching', employmentType: 'full_time', joinedOn: '2026-06-01' },
  conflict: { description: 'That employee number or login account is already used in this school.', message: 'That employee number is already used in this school' },
  updateBody: updateStaffSchema, updateExample: { phone: '9876543210' },
  withDelete: true, deleteSummary: 'Retire a staff member', deleteDescription: 'Soft delete: the row stays (history, payroll later), it just disappears from every list and lookup.',
});

// ---------------------------------------------------------------- Subjects
crud({
  tag: 'Subjects', base: '/subjects', module: 'subjects', resourceName: 'subject', idDesc: 'The subject id from GET /subjects',
  item: Subject, listQuery: listSubjectsSchema, paged: true, listDescription: 'Paged. `q` searches code and name.',
  withGetOne: true,
  createBody: createSubjectSchema, createExample: { code: 'MATH10', name: 'Mathematics', subjectType: 'core' },
  conflict: { description: 'That code is already used in this school.', message: 'A subject with this code already exists' },
  updateBody: updateSubjectSchema, updateExample: { name: 'Mathematics (Advanced)' },
  withDelete: true,
});

// ---------------------------------------------------------------- Classes & Sections
crud({
  tag: 'Classes', base: '/classes', module: 'classes', resourceName: 'class', idDesc: 'The class id from GET /classes',
  item: ClassRow, listQuery: listClassesSchema, paged: true, listDescription: 'Paged. `q` searches name and code.',
  withGetOne: true,
  createBody: createClassSchema, createExample: { gradeLevel: 10, name: 'Grade 10', code: 'G10' },
  conflict: { description: 'That code is already used in this school.', message: 'A class with this code already exists' },
  updateBody: updateClassSchema, updateExample: { stream: 'Science' },
  withDelete: true,
});

registry.registerPath({
  method: 'get', path: '/classes/{id}/subjects', tags: ['Classes'], summary: "A class's subjects",
  description: `Each entry carries the exam/internal marks split and whether it is elective.${needs('classes.view')}`,
  security: bearer, request: { params: idParam('The class id from GET /classes') },
  responses: { 200: reply("The class's subjects.", envelope('ClassSubjectsResponse', z.array(ClassSubject))), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such class in this school.', 'Class not found') },
});

registry.registerPath({
  method: 'put', path: '/classes/{id}/subjects', tags: ['Classes'], summary: "Replace a class's subjects",
  description: `Sends the WHOLE list - anything left out is removed from the class. A subject may only appear once.${needs('classes.edit')}`,
  security: bearer,
  request: {
    params: idParam('The class id from GET /classes'),
    body: { required: true, ...json(setClassSubjectsSchema, { subjects: [{ subjectId: '201', isElective: false, examMarks: 80, internalMarks: 20 }] }) },
  },
  responses: { 200: reply("The class's updated subjects.", envelope('SetClassSubjectsResponse', z.array(ClassSubject))), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such class in this school.', 'Class not found') },
});

crud({
  tag: 'Classes', base: '/sections', module: 'classes', resourceName: 'section', idDesc: 'The section id from GET /sections',
  item: Section, listQuery: listSectionsSchema, paged: true,
  withGetOne: true,
  createBody: createSectionSchema, createExample: { classId: '301', name: 'A', capacity: 40 },
  updateBody: updateSectionSchema, updateExample: { capacity: 45 },
  withDelete: true,
});

// ---------------------------------------------------------------- Timetable (time slots, section teachers, entries)
crud({
  tag: 'Timetable', base: '/time-slots', module: 'timetable', resourceName: 'time slot', idDesc: 'The time slot id',
  item: TimeSlot, listQuery: listTimeSlotsSchema,
  createBody: createTimeSlotSchema, createExample: { name: 'Period 1', sequence: 1, startsAt: '09:00', endsAt: '09:40' },
  updateBody: updateTimeSlotSchema, updateExample: { endsAt: '09:45' },
  withDelete: true,
});

crud({
  tag: 'Timetable', base: '/section-teachers', module: 'timetable', resourceName: 'section-teacher assignment', idDesc: 'The assignment id',
  item: SectionTeacher, listQuery: listSectionTeachersSchema, paged: true,
  listDescription: 'Which teacher takes a subject for a section in an academic year - the building block timetable entries and homework default to.',
  createBody: createSectionTeacherSchema, createExample: { sectionId: '302', subjectId: '201', academicYearId: '1', teacherId: '101' },
  updateBody: updateSectionTeacherSchema, updateExample: { teacherId: '102' },
  withDelete: true,
});

crud({
  tag: 'Timetable', base: '/timetable', module: 'timetable', resourceName: 'timetable entry', idDesc: 'The entry id',
  item: TimetableEntry, listQuery: listEntriesSchema, paged: true,
  listDescription: '`onDate` returns only entries in effect on that date. Creating a clashing entry (same section, teacher, classroom or break slot at the same time) is refused.',
  createBody: createEntrySchema, createExample: { sectionId: '302', subjectId: '201', timeSlotId: '401', dayOfWeek: 1, academicYearId: '1', effectiveFrom: '2026-06-01' },
  conflict: { description: 'The section, teacher, classroom or time slot already has an entry that overlaps this one.', message: 'That section, teacher or classroom already has an entry at this time' },
  updateBody: updateEntrySchema, updateExample: { classroomId: '12' },
  withDelete: true,
});

// ---------------------------------------------------------------- Homework (LMS basic)
crud({
  tag: 'Homework', base: '/homework', module: 'homework', resourceName: 'homework', idDesc: 'The homework id from GET /homework',
  item: Homework, listQuery: listHomeworkSchema, paged: true,
  listDescription: 'Paged. `q` searches the title. New homework starts as `draft`; see `/publish` and `/close` below.',
  withGetOne: true,
  createBody: createHomeworkSchema, createExample: { sectionId: '302', subjectId: '201', academicYearId: '1', title: 'Chapter 4 exercises', assignedOn: '2026-11-20', dueAt: '2026-11-27T17:00:00+05:30' },
  updateBody: updateHomeworkSchema, updateExample: { description: 'Questions 1-10 only' },
  withDelete: true, deleteDescription: 'Submissions are removed along with it.',
});

registry.registerPath({
  method: 'post', path: '/homework/{id}/publish', tags: ['Homework'], summary: 'Publish a homework',
  description: `Draft → published: students can now see it.${needs('homework.edit')}`,
  security: bearer, request: { params: idParam('The homework id from GET /homework') },
  responses: { 200: reply('The published homework.', envelope('PublishHomeworkResponse', Homework)), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such homework in this school.', 'Homework not found') },
});

registry.registerPath({
  method: 'post', path: '/homework/{id}/close', tags: ['Homework'], summary: 'Close a homework',
  description: `Published → closed: no further submissions are accepted.${needs('homework.edit')}`,
  security: bearer, request: { params: idParam('The homework id from GET /homework') },
  responses: { 200: reply('The closed homework.', envelope('CloseHomeworkResponse', Homework)), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such homework in this school.', 'Homework not found') },
});

registry.registerPath({
  method: 'get', path: '/homework/{id}/submissions', tags: ['Homework'], summary: 'List a homework\'s submissions',
  description: `Paged.${needs('homework.view')}`,
  security: bearer, request: { params: idParam('The homework id from GET /homework'), query: listSubmissionsSchema },
  responses: { 200: reply('One page of submissions.', pagedEnvelope('HomeworkSubmissionListResponse', HomeworkSubmission)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such homework in this school.', 'Homework not found') },
});

registry.registerPath({
  method: 'post', path: '/homework/{id}/submissions', tags: ['Homework'], summary: 'Record a submission',
  description: `Recorded as \`submitted\` or \`late\` depending on \`submittedAt\` versus the homework's \`dueAt\` (and whether late submissions are allowed at all).${needs('homework.edit')}`,
  security: bearer,
  request: { params: idParam('The homework id from GET /homework'), body: { required: true, ...json(recordSubmissionSchema, { enrollmentId: '55' }) } },
  responses: { 201: reply('Submission recorded.', envelope('RecordSubmissionResponse', HomeworkSubmission)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such homework in this school.', 'Homework not found') },
});

registry.registerPath({
  method: 'patch', path: '/homework-submissions/{id}/grade', tags: ['Homework'], summary: 'Grade a submission',
  description: `Send \`resubmissionRequired: true\` instead of a score to send it back ungraded.${needs('homework.edit')}`,
  security: bearer,
  request: { params: idParam('The submission id from GET /homework/{id}/submissions'), body: { required: true, ...json(gradeSubmissionSchema, { score: 8.5 }) } },
  responses: { 200: reply('The graded submission.', envelope('GradeSubmissionResponse', HomeworkSubmission)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such submission in this school.', 'Submission not found') },
});

// ---------------------------------------------------------------- Transport
crud({
  tag: 'Transport', base: '/vehicles', module: 'transport', resourceName: 'vehicle', idDesc: 'The vehicle id from GET /vehicles',
  item: Vehicle, listQuery: listVehiclesSchema, paged: true,
  listDescription: 'Paged. `q` searches registration number, make and model. `expiringWithinDays` flags insurance/fitness/permit/pollution documents due soon.',
  withGetOne: true,
  createBody: createVehicleSchema, createExample: { registrationNo: 'KA01AB1234', vehicleType: 'bus', seatingCapacity: 40 },
  conflict: { description: 'That registration number is already used in this school.', message: 'That registration number is already used in this school' },
  updateBody: updateVehicleSchema, updateExample: { odometerKm: 52000 },
  withDelete: true, deleteSummary: 'Retire a vehicle', deleteDescription: 'Sets status to retired rather than deleting the row (it may still be on past schedules).',
});

crud({
  tag: 'Transport', base: '/drivers', module: 'transport', resourceName: 'driver', idDesc: 'The driver id from GET /drivers',
  item: Driver, listQuery: listDriversSchema, paged: true,
  listDescription: 'Paged. `q` searches name, phone and licence number. `expiringWithinDays` flags a licence due soon.',
  withGetOne: true,
  createBody: createDriverSchema, createExample: { fullName: 'Ramesh Kumar', phone: '9876500000', licenseNo: 'KA0120230001234', licenseExpiry: '2028-01-01' },
  conflict: { description: 'That licence number is already used in this school.', message: 'That licence number is already used in this school' },
  updateBody: updateDriverSchema, updateExample: { phone: '9876511111' },
  withDelete: true, deleteSummary: 'Deactivate a driver', deleteDescription: 'Sets status to inactive rather than deleting the row.',
});

crud({
  tag: 'Transport', base: '/transport-routes', module: 'transport', resourceName: 'route', idDesc: 'The route id from GET /transport-routes',
  item: TransportRoute, listQuery: listRoutesSchema, paged: true,
  withGetOne: true,
  createBody: createRouteSchema, createExample: { code: 'R1', name: 'North Loop' },
  conflict: { description: 'That code is already used in this school.', message: 'A route with this code already exists' },
  updateBody: updateRouteSchema, updateExample: { estimatedMinutes: 35 },
  withDelete: true, deleteSummary: 'Deactivate a route', deleteDescription: 'Sets status to inactive rather than deleting the row.',
});

crud({
  tag: 'Transport', base: '/pickup-points', module: 'transport', resourceName: 'pickup point', idDesc: 'The pickup point id',
  item: PickupPoint, listQuery: listPickupPointsSchema,
  createBody: createPickupPointSchema, createExample: { routeId: '603', name: 'Market Square', sequence: 1, monthlyFee: 500 },
  updateBody: updatePickupPointSchema, updateExample: { landmark: 'Opposite the post office' },
  withDelete: true,
});

crud({
  tag: 'Transport', base: '/route-schedules', module: 'transport', resourceName: 'route schedule', idDesc: 'The schedule id',
  item: RouteSchedule, listQuery: listSchedulesSchema, paged: true,
  listDescription: '`activeOn` returns only schedules valid on that date.',
  createBody: createScheduleSchema, createExample: { routeId: '603', vehicleId: '601', driverId: '602', shift: 'morning', operatingDays: [1, 2, 3, 4, 5], validFrom: '2026-06-01', validTo: '2027-03-31' },
  updateBody: updateScheduleSchema, updateExample: { driverId: '604' },
  withDelete: true,
});

crud({
  tag: 'Transport', base: '/transport-assignments', module: 'transport', resourceName: 'transport assignment', idDesc: 'The assignment id',
  item: TransportAssignment, listQuery: listAssignmentsSchema, paged: true,
  listDescription: 'A student or staff assignment to a route and pickup point. To change the route, end this assignment and create a new one.',
  createBody: createAssignmentSchema, createExample: { studentId: '901', academicYearId: '1', routeId: '603', pickupPointId: '604' },
  updateBody: updateAssignmentSchema, updateExample: { pickupPointId: '605' },
  withDelete: true, deleteSummary: 'End an assignment', deleteDescription: 'Sets status to ended rather than deleting the row.',
});

// ---------------------------------------------------------------- Assets
crud({
  tag: 'Assets', base: '/asset-categories', module: 'assets', resourceName: 'asset category', idDesc: 'The category id',
  item: AssetCategory,
  listDescription: 'Not paged - schools rarely have more than a few dozen categories.',
  createBody: createCategorySchema, createExample: { name: 'Laptops', depreciationMethod: 'straight_line', usefulLifeYears: 4 },
  updateBody: updateCategorySchema, updateExample: { usefulLifeYears: 5 },
  withDelete: true,
});

crud({
  tag: 'Assets', base: '/assets', module: 'assets', resourceName: 'asset', idDesc: 'The asset id from GET /assets',
  item: Asset, listQuery: listAssetsSchema, paged: true,
  listDescription: 'Paged. `q` searches tag, name and serial number. `warrantyExpiringWithinDays` flags warranties due soon.',
  withGetOne: true,
  createBody: createAssetSchema, createExample: { name: 'Dell Latitude 5440', categoryId: '701' },
  conflict: { description: 'That asset tag is already used in this school.', message: 'That asset tag is already used in this school' },
  updateBody: updateAssetSchema, updateExample: { condition: 'fair' },
  withDelete: true, deleteSummary: "Dispose an asset (today, no details)",
  deleteDescription: "Equivalent to `POST /assets/{id}/dispose` with no body: disposed today, no value or notes recorded.",
});

registry.registerPath({
  method: 'post', path: '/assets/{id}/dispose', tags: ['Assets'], summary: 'Dispose an asset, with details',
  description: `Status becomes \`disposed\`, which no other endpoint can set directly.${needs('assets.delete')}`,
  security: bearer,
  request: { params: idParam('The asset id from GET /assets'), body: { ...json(disposeAssetSchema, { disposalValue: 50 }) } },
  responses: { 200: reply('The disposed asset.', envelope('DisposeAssetResponse', Asset)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such asset in this school.', 'Asset not found') },
});

crud({
  tag: 'Assets', base: '/asset-allocations', module: 'assets', resourceName: 'asset allocation', idDesc: 'The allocation id',
  item: AssetAllocation, listQuery: listAllocationsSchema, paged: true,
  listDescription: 'Who currently holds what. `open: true` = not yet returned; `overdue: true` = not returned and past its expected return date. An asset can have at most one open allocation at a time.',
  createBody: createAllocationSchema, createExample: { assetId: '702', staffId: '101' },
  conflict: { description: 'This asset already has an open (not yet returned) allocation.', message: 'This asset is already allocated' },
  updateBody: updateAllocationSchema, updateExample: { expectedReturnOn: '2027-01-15' },
});

registry.registerPath({
  method: 'post', path: '/asset-allocations/{id}/return', tags: ['Assets'], summary: 'Return an allocated asset',
  description: `Sets \`returnedOn\`, freeing the asset for its next allocation.${needs('assets.edit')}`,
  security: bearer,
  request: { params: idParam('The allocation id'), body: { required: true, ...json(returnAllocationSchema, { conditionIn: 'good' }) } },
  responses: { 200: reply('The returned allocation.', envelope('ReturnAllocationResponse', AssetAllocation)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such allocation in this school.', 'Allocation not found') },
});

crud({
  tag: 'Assets', base: '/asset-maintenance', module: 'assets', resourceName: 'maintenance record', idDesc: 'The maintenance record id',
  item: AssetMaintenance, listQuery: listMaintenanceSchema, paged: true,
  listDescription: '`dueWithinDays` flags scheduled maintenance that is overdue or coming up soon.',
  createBody: createMaintenanceSchema, createExample: { assetId: '702', maintenanceType: 'repair', description: 'Screen replacement' },
  updateBody: updateMaintenanceSchema, updateExample: { status: 'completed', completedOn: '2026-11-20' },
  withDelete: true, deleteSummary: 'Cancel a maintenance record', deleteDescription: 'Sets status to cancelled rather than deleting the row.',
});

// ---------------------------------------------------------------- Admissions
crud({
  tag: 'Admissions', base: '/admissions', module: 'admissions', resourceName: 'admission', idDesc: 'The admission id from GET /admissions',
  item: Admission, listQuery: listAdmissionsSchema, paged: true,
  listDescription: 'Paged. `q` searches application number, applicant name, guardian name/phone and email.',
  withGetOne: true,
  createBody: createAdmissionSchema,
  createExample: {
    academicYearId: '1', classId: '301', firstName: 'Aarav', lastName: 'Sharma', dob: '2016-04-12',
    guardianName: 'Rajesh Sharma', guardianPhone: '9876543210', source: 'walk_in',
  },
  conflict: { description: 'That application number is already used in this school.', message: 'That application number is already used in this school' },
  updateBody: updateAdmissionSchema, updateExample: { feePaid: true, feePaidOn: '2026-11-12', feePaymentMethod: 'upi' },
  withDelete: true, deleteSummary: 'Delete a non-accepted admission', deleteDescription: 'Soft delete; accepted admissions linked to a student cannot be deleted.',
});

registry.registerPath({
  method: 'get', path: '/admissions/{id}/history', tags: ['Admissions'], summary: 'Admission status history',
  description: `Audit trail of every status change on an admission.${needs('admissions.view')}`,
  security: bearer, request: { params: idParam('The admission id from GET /admissions') },
  responses: { 200: reply('Chronological status history.', envelope('AdmissionHistoryResponse', z.array(AdmissionStatusHistoryItem))), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such admission in this school.', 'Admission not found') },
});

registry.registerPath({
  method: 'post', path: '/admissions/{id}/status', tags: ['Admissions'], summary: 'Transition admission status',
  description: `Updates the admission status and appends a row to \`admission_status_history\`. Setting \`status: "accepted"\` atomically creates the student, primary guardian and student-guardian link.${needs('admissions.edit')}`,
  security: bearer,
  request: { params: idParam('The admission id from GET /admissions'), body: { required: true, ...json(changeAdmissionStatusSchema, { status: 'shortlisted', note: 'Documents verified' }) } },
  responses: { 200: reply('Updated admission with history.', envelope('AdmissionStatusResponse', Admission)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such admission in this school.', 'Admission not found'), 409: fail('Invalid status transition or already accepted.', 'An accepted admission cannot change status') },
});

registry.registerPath({
  method: 'post', path: '/admissions/{id}/accept', tags: ['Admissions'], summary: 'Accept an admission and enrol student',
  description: `Transitions the admission to \`accepted\`, creates the student and guardian records in one transaction, and links them.${needs('admissions.edit')}`,
  security: bearer,
  request: { params: idParam('The admission id from GET /admissions'), body: { ...json(acceptAdmissionSchema, { decisionNotes: 'Welcome!' }) } },
  responses: { 200: reply('Accepted admission with linked student and history.', envelope('AcceptAdmissionResponse', Admission)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such admission in this school.', 'Admission not found'), 409: fail('Already accepted or terminal.', 'An accepted admission cannot change status') },
});

// ---------------------------------------------------------------- Students, Guardians, Documents & Houses
crud({
  tag: 'Students', base: '/students', module: 'students', resourceName: 'student', idDesc: 'The student id from GET /students',
  item: Student, listQuery: listStudentsSchema, paged: true,
  listDescription: 'Paged. `q` searches admission number and student name.',
  withGetOne: true,
  createBody: createStudentSchema,
  createExample: { firstName: 'Meera', lastName: 'Nair', dob: '2015-08-20', admittedOn: '2026-06-01' },
  conflict: { description: 'Admission number or admission link is already used in this school.', message: 'That admission number or admission link is already used in this school' },
  updateBody: updateStudentSchema, updateExample: { bloodGroup: 'O+' },
  withDelete: true, deleteSummary: 'Soft-delete a student',
});

registry.registerPath({
  method: 'patch', path: '/students/{id}/status', tags: ['Students'], summary: 'Update student status',
  description: `Requires \`leftOn\` when status is \`alumni\`, \`transferred_out\` or \`expelled\`.${needs('students.edit')}`,
  security: bearer,
  request: { params: idParam('The student id from GET /students'), body: { required: true, ...json(updateStudentStatusSchema, { status: 'transferred_out', leftOn: '2027-03-31', leftReason: 'Relocated' }) } },
  responses: { 200: reply('Updated student.', envelope('UpdateStudentStatusResponse', Student)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such student in this school.', 'Student not found') },
});

registry.registerPath({
  method: 'get', path: '/students/{id}/guardians', tags: ['Students'], summary: 'List guardians of a student',
  description: needs('students.view'), security: bearer, request: { params: idParam('The student id from GET /students') },
  responses: { 200: reply('Guardians linked to this student.', envelope('StudentGuardianListResponse', z.array(StudentGuardian))), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such student in this school.', 'Student not found') },
});

registry.registerPath({
  method: 'post', path: '/students/{id}/guardians', tags: ['Students'], summary: 'Link or create-and-link a guardian for a student',
  description: `Send \`guardianId\` to link an existing guardian (e.g. a sibling's parent) or \`guardian\` to create a new guardian profile and link it.${needs('students.edit')}`,
  security: bearer,
  request: { params: idParam('The student id from GET /students'), body: { required: true, ...json(linkStudentGuardianSchema, { guardianId: '902', isPrimary: true, canPickUp: true }) } },
  responses: { 201: reply('Updated guardians list for the student.', envelope('LinkStudentGuardianResponse', z.array(StudentGuardian))), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such student in this school.', 'Student not found'), 409: fail('Already linked.', 'This guardian is already linked to this student') },
});

registry.registerPath({
  method: 'patch', path: '/students/{id}/guardians/{guardianId}', tags: ['Students'], summary: 'Update primary guardian or pickup authorization',
  description: needs('students.edit'), security: bearer,
  request: { params: z.object({ id: z.string(), guardianId: z.string() }), body: { required: true, ...json(updateStudentGuardianSchema, { isPrimary: true, canPickUp: true }) } },
  responses: { 200: reply('Updated guardians list for the student.', envelope('UpdateStudentGuardianResponse', z.array(StudentGuardian))), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('Student or guardian link not found.', 'Guardian is not linked to this student') },
});

registry.registerPath({
  method: 'delete', path: '/students/{id}/guardians/{guardianId}', tags: ['Students'], summary: 'Unlink a guardian from a student',
  description: needs('students.edit'), security: bearer,
  request: { params: z.object({ id: z.string(), guardianId: z.string() }) },
  responses: { 204: { description: 'Unlinked. No body.' }, 401: E.unauthorized, 403: E.noPermission, 404: fail('Student or guardian link not found.', 'Guardian is not linked to this student') },
});

registry.registerPath({
  method: 'get', path: '/students/{id}/documents', tags: ['Students'], summary: 'List documents for a student',
  description: needs('students.view'), security: bearer, request: { params: idParam('The student id from GET /students') },
  responses: { 200: reply('Student documents.', envelope('StudentDocumentListResponse', z.array(StudentDocument))), 401: E.unauthorized, 403: E.noPermission, 404: fail('No such student in this school.', 'Student not found') },
});

registry.registerPath({
  method: 'post', path: '/students/{id}/documents', tags: ['Students'], summary: 'Add a document to a student',
  description: needs('students.edit'), security: bearer,
  request: { params: idParam('The student id from GET /students'), body: { required: true, ...json(createStudentDocumentSchema, { documentType: 'birth_certificate', fileId: '1' }) } },
  responses: { 201: reply('Document added.', envelope('CreateStudentDocumentResponse', StudentDocument)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such student in this school.', 'Student not found') },
});

registry.registerPath({
  method: 'patch', path: '/students/{id}/documents/{docId}', tags: ['Students'], summary: 'Update a student document',
  description: needs('students.edit'), security: bearer,
  request: { params: z.object({ id: z.string(), docId: z.string() }), body: { required: true, ...json(updateStudentDocumentSchema, { documentNo: 'BC-12345' }) } },
  responses: { 200: reply('Updated document.', envelope('UpdateStudentDocumentResponse', StudentDocument)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such document in this school.', 'Student document not found') },
});

registry.registerPath({
  method: 'patch', path: '/students/{id}/documents/{docId}/verify', tags: ['Students'], summary: 'Verify or reject a student document',
  description: needs('students.edit'), security: bearer,
  request: { params: z.object({ id: z.string(), docId: z.string() }), body: { required: true, ...json(verifyStudentDocumentSchema, { verifiedStatus: 'verified', remarks: 'Original verified' }) } },
  responses: { 200: reply('Verified/rejected document.', envelope('VerifyStudentDocumentResponse', StudentDocument)), 400: E.validation, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such document in this school.', 'Student document not found') },
});

registry.registerPath({
  method: 'delete', path: '/students/{id}/documents/{docId}', tags: ['Students'], summary: 'Delete a student document',
  description: needs('students.edit'), security: bearer,
  request: { params: z.object({ id: z.string(), docId: z.string() }) },
  responses: { 204: { description: 'Deleted. No body.' }, 401: E.unauthorized, 403: E.noPermission, 404: fail('No such document in this school.', 'Student document not found') },
});

crud({
  tag: 'Guardians', base: '/guardians', module: 'students', resourceName: 'guardian', idDesc: 'The guardian id from GET /guardians',
  item: Guardian, listQuery: listGuardiansSchema, paged: true,
  listDescription: 'Paged. `q` searches full name, phone and email.',
  withGetOne: true,
  createBody: createGuardianSchema, createExample: { fullName: 'Sunita Sharma', relation: 'mother', phone: '9876543211', isEmergencyContact: true },
  updateBody: updateGuardianSchema, updateExample: { occupation: 'Architect' },
  withDelete: true,
});

crud({
  tag: 'Student Houses', base: '/student-houses', module: 'students', resourceName: 'student house', idDesc: 'The house id from GET /student-houses',
  item: StudentHouse, listQuery: listStudentHousesSchema,
  withGetOne: true,
  createBody: createStudentHouseSchema, createExample: { name: 'Sapphire House', color: '#2563EB', motto: 'Strive for Excellence' },
  conflict: { description: 'A house with that name already exists in this school.', message: 'A student house with that name already exists in this school' },
  updateBody: updateStudentHouseSchema, updateExample: { color: '#1D4ED8' },
  withDelete: true,
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
      { name: 'Staff', description: 'Teaching and non-teaching staff' },
      { name: 'Subjects' },
      { name: 'Classes', description: 'Classes, sections and which subjects each class takes' },
      { name: 'Timetable', description: 'Time slots, section-teacher assignments, the weekly schedule' },
      { name: 'Homework', description: 'Homework (basic LMS) and its submissions' },
      { name: 'Transport', description: 'Vehicles, drivers, routes, pickup points, schedules, assignments' },
      { name: 'Assets', description: 'Categories, assets, allocations, maintenance' },
      { name: 'Admissions', description: 'Admission applications, status transitions and history' },
      { name: 'Students', description: 'Student profiles, student-guardian links and student documents' },
      { name: 'Guardians', description: 'Parent/guardian profiles reusable across siblings' },
      { name: 'Student Houses', description: 'School houses for inter-house events' },
    ],
  });
}
