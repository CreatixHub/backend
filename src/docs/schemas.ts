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
    username: z.string().nullable().openapi({ example: 'alice.owner' }),
    name: z.string().openapi({ example: 'Alice Owner' }),
    email: z.string().nullable().openapi({ example: 'alice@example.test' }),
    role: z
      .enum(FRONTEND_ROLES)
      .nullable()
      .openapi({ description: 'One role for the frontend, derived from the roles in the active school. null while there is no school.' }),
    userType: z.enum(['student', 'guardian', 'staff', 'admin', 'owner']),
    status: z.enum(['active', 'invited', 'suspended', 'deleted']),
    permissions: z.array(z.string()).openapi({ example: ['*'], description: '["*"] = every permission (owners). [] while there is no school.' }),
    avatar: z.string().nullable(),
    avatarFileId: id('1').nullable(),
    phone: z.string().nullable(),
    languageId: id('1').nullable(),
    timezone: z.string().nullable(),
    preferences: z.record(z.string(), z.unknown()),
    mustChangePassword: z.boolean(),
    mfaEnabled: z.boolean(),
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
    username: z.string().nullable(),
    name: z.string().openapi({ example: 'Bob Teacher' }),
    email: z.string().nullable().openapi({ example: 'bob@example.test' }),
    phone: z.string().nullable(),
    userType: z.enum(['student', 'guardian', 'staff', 'admin', 'owner']),
    userStatus: z.enum(['active', 'invited', 'suspended', 'deleted']),
    invitedAt: z.string().datetime().nullable(),
    lastLoginAt: z.string().datetime().nullable(),
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

// ---------------------------------------------------------------- Staff, Subjects, Classes & Sections,
// Timetable, Homework, Transport, Assets (added 2026-11-12, alongside #41/#42). Each mirrors what its
// service's toX()/toRow() helper actually returns: the full row minus tenantId (and deletedAt/deletedBy
// where the module soft-deletes). Not every field carries an .openapi() example - only the ones worth
// calling out; zod-to-openapi still documents every field's type either way.

export const Staff = z
  .object({
    id: id('101'), employeeNo: z.string().openapi({ example: 'EMP-0001' }), userId: id('8').nullable(),
    staffType: z.enum(['teaching', 'non_teaching']), employmentType: z.enum(['full_time', 'part_time', 'contract', 'visiting']),
    departmentId: id('1').nullable(), designationId: id('1').nullable(), reportsToId: id('1').nullable(),
    status: z.enum(['active', 'on_leave', 'suspended', 'left']),
    firstName: z.string().nullable(), lastName: z.string().nullable(), fullName: z.string().nullable(),
    dob: z.string().nullable(), gender: z.string().nullable(), bloodGroup: z.string().nullable(), maritalStatus: z.string().nullable(),
    fatherName: z.string().nullable(), motherTongueId: id('1').nullable(),
    email: z.string().nullable(), phone: z.string().nullable(), altPhone: z.string().nullable(),
    addressLine1: z.string().nullable(), addressLine2: z.string().nullable(), cityId: id('1').nullable(), postalCode: z.string().nullable(),
    permanentAddressSame: z.boolean(), permanentAddressLine1: z.string().nullable(), permanentAddressLine2: z.string().nullable(),
    permanentCityId: id('1').nullable(), permanentPostalCode: z.string().nullable(),
    joinedOn: z.string(), probationEndsOn: z.string().nullable(), confirmedOn: z.string().nullable(),
    leftOn: z.string().nullable(), leftReason: z.string().nullable(),
    qualification: z.string().nullable(), experienceYears: z.string().nullable().openapi({ description: 'Stored to 1 decimal place' }),
    epfNo: z.string().nullable(), bankAccountName: z.string().nullable(), bankName: z.string().nullable(),
    bankBranch: z.string().nullable(), bankIfsc: z.string().nullable(), bankMicr: z.string().nullable(),
    hasNationalId: z.boolean().openapi({ description: 'true if a national ID is on file - the value itself is never returned' }),
    hasPan: z.boolean().openapi({ description: 'true if a PAN is on file - the value itself is never returned' }),
    hasBankAccount: z.boolean().openapi({ description: 'true if a bank account number is on file - the value itself is never returned' }),
    emergencyContactName: z.string().nullable(), emergencyContactPhone: z.string().nullable(),
    photoFileId: id('1').nullable(), socialLinks: z.record(z.string(), z.string()),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Staff');

export const Subject = z
  .object({
    id: id('201'), code: z.string().openapi({ example: 'MATH10' }), name: z.string().openapi({ example: 'Mathematics' }),
    subjectType: z.enum(['core', 'elective', 'co_curricular', 'language']), credits: z.string().nullable(),
    color: z.string().nullable().openapi({ example: '#3B82F6' }), departmentId: id('1').nullable(),
    status: z.enum(['active', 'inactive']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Subject');

export const ClassRow = z
  .object({
    id: id('301'), gradeLevel: z.number().int().openapi({ example: 10 }), name: z.string().openapi({ example: 'Grade 10' }),
    code: z.string(), stream: z.string().nullable(), category: z.string().nullable(), displayOrder: z.number().int(),
    status: z.enum(['active', 'inactive']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Class');

export const Section = z
  .object({
    id: id('302'), classId: id('301'), name: z.string().openapi({ example: 'A' }), capacity: z.number().int(),
    defaultClassroomId: id('1').nullable(), shift: z.enum(['morning', 'afternoon', 'evening']), medium: z.string().nullable(),
    status: z.enum(['active', 'inactive']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Section');

export const ClassSubject = z
  .object({
    subjectId: id('201'), isElective: z.boolean(), periodsPerWeek: z.number().int().nullable(), displayOrder: z.number().int(),
    examMarks: z.string(), internalMarks: z.string(), passMarks: z.string().nullable(),
  })
  .openapi('ClassSubject');

export const TimeSlot = z
  .object({
    id: id('401'), name: z.string().openapi({ example: 'Period 1' }), sequence: z.number().int(),
    startsAt: z.string().openapi({ example: '09:00' }), endsAt: z.string().openapi({ example: '09:40' }),
    isBreak: z.boolean(), isActive: z.boolean(),
  })
  .openapi('TimeSlot');

export const SectionTeacher = z
  .object({
    id: id('402'), sectionId: id('302'), subjectId: id('201'), academicYearId: id('1'), teacherId: id('101'),
  })
  .openapi('SectionTeacher');

export const TimetableEntry = z
  .object({
    id: id('403'), sectionId: id('302'), subjectId: id('201'), teacherId: id('101'), timeSlotId: id('401'),
    classroomId: id('1').nullable(), dayOfWeek: z.number().int().min(1).max(7).openapi({ description: '1 = Monday ... 7 = Sunday' }),
    academicYearId: id('1'), effectiveFrom: z.string(), effectiveTo: z.string().nullable(),
    status: z.enum(['active', 'inactive']),
  })
  .openapi('TimetableEntry');

export const Homework = z
  .object({
    id: id('501'), sectionId: id('302'), subjectId: id('201'), teacherId: id('101'), academicYearId: id('1'),
    title: z.string(), description: z.string().nullable(),
    homeworkType: z.enum(['assignment', 'project', 'reading', 'practice']), priority: z.enum(['low', 'normal', 'high']),
    durationMinutes: z.number().int().nullable(), assignedOn: z.string(), dueAt: z.string().datetime(),
    maxMarks: z.string().nullable(), submissionRequired: z.boolean(), allowLate: z.boolean(),
    latePenaltyPercent: z.string().nullable(), submissionType: z.enum(['text', 'file', 'both']),
    status: z.enum(['draft', 'published', 'closed']),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Homework');

export const HomeworkSubmission = z
  .object({
    id: id('502'), homeworkId: id('501'), enrollmentId: id('1'), submittedAt: z.string().datetime().nullable(),
    textAnswer: z.string().nullable(), fileId: id('1').nullable(), lateReason: z.string().nullable(),
    status: z.enum(['not_submitted', 'submitted', 'late', 'graded']),
    score: z.string().nullable(), gradeLabel: z.string().nullable(), feedback: z.string().nullable(),
    gradedAt: z.string().datetime().nullable(),
  })
  .openapi('HomeworkSubmission');

export const Vehicle = z
  .object({
    id: id('601'), registrationNo: z.string().openapi({ example: 'KA01AB1234' }), vehicleType: z.enum(['bus', 'van', 'car']),
    seatingCapacity: z.number().int(), insuranceExpiry: z.string().nullable(), fitnessExpiry: z.string().nullable(),
    permitExpiry: z.string().nullable(), pollutionExpiry: z.string().nullable(), gpsDeviceId: z.string().nullable(),
    chassisNo: z.string().nullable(), engineNo: z.string().nullable(), make: z.string().nullable(), model: z.string().nullable(),
    manufactureYear: z.number().int().nullable(), odometerKm: z.number().int().nullable(),
    status: z.enum(['active', 'maintenance', 'retired']),
  })
  .openapi('Vehicle');

export const Driver = z
  .object({
    id: id('602'), staffId: id('101').nullable(), fullName: z.string(), phone: z.string(),
    licenseNo: z.string(), licenseExpiry: z.string(), status: z.enum(['active', 'inactive']),
  })
  .openapi('Driver');

export const TransportRoute = z
  .object({
    id: id('603'), code: z.string(), name: z.string(), startLocation: z.string().nullable(), endLocation: z.string().nullable(),
    distanceKm: z.string().nullable(), estimatedMinutes: z.number().int().nullable(),
    shift: z.enum(['morning', 'afternoon', 'both']), status: z.enum(['active', 'inactive']),
  })
  .openapi('TransportRoute');

export const PickupPoint = z
  .object({
    id: id('604'), routeId: id('603'), name: z.string(), sequence: z.number().int(), landmark: z.string().nullable(),
    latitude: z.string().nullable(), longitude: z.string().nullable(), pickupTime: z.string().nullable(),
    dropTime: z.string().nullable(), monthlyFee: z.string(),
  })
  .openapi('PickupPoint');

export const RouteSchedule = z
  .object({
    id: id('605'), routeId: id('603'), vehicleId: id('601'), driverId: id('602'), attendantStaffId: id('101').nullable(),
    shift: z.enum(['morning', 'afternoon']), operatingDays: z.array(z.number().int().min(1).max(7)),
    validFrom: z.string(), validTo: z.string(),
  })
  .openapi('RouteSchedule');

export const TransportAssignment = z
  .object({
    id: id('606'), studentId: id('1').nullable(), staffId: id('101').nullable(), academicYearId: id('1'),
    routeId: id('603'), pickupPointId: id('604'), direction: z.enum(['pickup', 'drop', 'both']),
    monthlyFee: z.string(), status: z.enum(['active', 'ended']), endedOn: z.string().nullable(),
  })
  .openapi('TransportAssignment');

export const AssetCategory = z
  .object({
    id: id('701'), name: z.string(), parentId: id('701').nullable(),
    depreciationMethod: z.enum(['straight_line', 'declining_balance', 'none']), usefulLifeYears: z.number().int().nullable(),
  })
  .openapi('AssetCategory');

export const Asset = z
  .object({
    id: id('702'), assetTag: z.string().openapi({ example: 'AST-0001' }), name: z.string(), categoryId: id('701'),
    vendorId: id('1').nullable(), branchId: id('1').nullable().openapi({ description: 'null until the Branches module exists' }),
    quantity: z.number().int(), serialNo: z.string().nullable(), model: z.string().nullable(),
    purchaseDate: z.string().nullable(), purchaseCost: z.string().nullable(), warrantyUntil: z.string().nullable(),
    salvageValue: z.string().nullable(), bookValue: z.string().nullable().openapi({ description: 'Computed from purchaseCost and the category\'s depreciation method' }),
    locationClassroomId: id('1').nullable(),
    status: z.enum(['in_use', 'in_store', 'under_repair', 'retired', 'disposed']), condition: z.enum(['new', 'good', 'fair', 'poor']),
    disposedOn: z.string().nullable(), disposalValue: z.string().nullable(), notes: z.string().nullable(),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .openapi('Asset');

export const AssetAllocation = z
  .object({
    id: id('703'), assetId: id('702'), staffId: id('101').nullable(), studentId: id('1').nullable(), classroomId: id('1').nullable(),
    allocatedOn: z.string(), expectedReturnOn: z.string().nullable(), returnedOn: z.string().nullable(),
    conditionOut: z.enum(['new', 'good', 'fair', 'poor']).nullable(), conditionIn: z.enum(['new', 'good', 'fair', 'poor']).nullable(),
    notes: z.string().nullable(),
  })
  .openapi('AssetAllocation');

export const AssetMaintenance = z
  .object({
    id: id('704'), assetId: id('702'), maintenanceType: z.enum(['scheduled', 'repair', 'inspection']),
    description: z.string().nullable(), reportedOn: z.string().nullable(), startedOn: z.string().nullable(), completedOn: z.string().nullable(),
    cost: z.string().nullable(), labourCost: z.string().nullable(), partsCost: z.string().nullable(), vendorId: id('1').nullable(),
    status: z.enum(['reported', 'in_progress', 'completed', 'cancelled']), nextDueOn: z.string().nullable(),
  })
  .openapi('AssetMaintenance');

export const AdmissionStatusHistoryItem = z
  .object({
    id: id('802'),
    admissionId: id('801'),
    fromStatus: z.string().nullable(),
    toStatus: z.string(),
    note: z.string().nullable(),
    changedBy: id('8').nullable(),
    changedByName: z.string().nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .openapi('AdmissionStatusHistoryItem');

export const Admission = z
  .object({
    id: id('801'),
    applicationNo: z.string().openapi({ example: 'APP-2026-0001' }),
    academicYearId: id('1'),
    classId: id('301'),
    firstName: z.string(),
    lastName: z.string(),
    dob: z.string(),
    gender: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    bloodGroup: z.string().nullable(),
    religionId: id('1').nullable(),
    socialCategory: z.string().nullable(),
    fatherName: z.string().nullable(),
    fatherPhone: z.string().nullable(),
    fatherEmail: z.string().nullable(),
    fatherOccupation: z.string().nullable(),
    motherName: z.string().nullable(),
    motherPhone: z.string().nullable(),
    motherEmail: z.string().nullable(),
    motherOccupation: z.string().nullable(),
    guardianName: z.string(),
    guardianPhone: z.string(),
    guardianEmail: z.string().nullable(),
    previousSchool: z.string().nullable(),
    previousClass: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    cityId: id('1').nullable(),
    postalCode: z.string().nullable(),
    status: z.enum(['enquiry', 'applied', 'document_review', 'shortlisted', 'waitlisted', 'offered', 'accepted', 'rejected', 'withdrawn']),
    appliedOn: z.string(),
    acknowledgedAt: z.string().datetime().nullable(),
    decisionOn: z.string().nullable(),
    decidedBy: id('8').nullable(),
    decisionNotes: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    waitlistPosition: z.number().int().nullable(),
    assignedToStaffId: id('101').nullable(),
    needsTransport: z.boolean(),
    needsHostel: z.boolean(),
    applicationFee: z.string().nullable(),
    feePaid: z.boolean(),
    feePaidOn: z.string().nullable(),
    feePaymentMethod: z.string().nullable(),
    source: z.enum(['walk_in', 'website', 'referral', 'agent', 'event', 'other']),
    studentId: id('901').nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Admission');

export const StudentHouse = z
  .object({
    id: id('905'),
    name: z.string().openapi({ example: 'Sapphire House' }),
    color: z.string().nullable().openapi({ example: '#2563EB' }),
    motto: z.string().nullable(),
    houseMasterId: id('101').nullable(),
    isActive: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('StudentHouse');

export const Guardian = z
  .object({
    id: id('902'),
    fullName: z.string(),
    relation: z.enum(['father', 'mother', 'guardian', 'other']),
    phone: z.string(),
    altPhone: z.string().nullable(),
    email: z.string().nullable(),
    occupation: z.string().nullable(),
    annualIncome: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    cityId: id('1').nullable(),
    postalCode: z.string().nullable(),
    photoFileId: id('1').nullable(),
    idProofType: z.string().nullable(),
    idProofNo: z.string().nullable(),
    isEmergencyContact: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Guardian');

export const StudentGuardian = Guardian.extend({
  isPrimary: z.boolean(),
  canPickUp: z.boolean(),
  linkedAt: z.string().datetime(),
}).openapi('StudentGuardian');

export const StudentDocument = z
  .object({
    id: id('903'),
    studentId: id('901'),
    documentType: z.string(),
    fileId: id('1'),
    documentNo: z.string().nullable(),
    issuedOn: z.string().nullable(),
    expiresOn: z.string().nullable(),
    verifiedStatus: z.enum(['pending', 'verified', 'rejected']),
    verifiedBy: id('8').nullable(),
    verifiedAt: z.string().datetime().nullable(),
    remarks: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('StudentDocument');

export const Student = z
  .object({
    id: id('901'),
    userId: id('8').nullable(),
    admissionId: id('801').nullable(),
    admissionNo: z.string().openapi({ example: 'STU-2026-0001' }),
    firstName: z.string(),
    lastName: z.string(),
    fullName: z.string().nullable(),
    dob: z.string(),
    gender: z.string().nullable(),
    bloodGroup: z.string().nullable(),
    religionId: id('1').nullable(),
    socialCategory: z.string().nullable(),
    motherTongueId: id('1').nullable(),
    photoFileId: id('1').nullable(),
    fatherName: z.string().nullable(),
    fatherPhone: z.string().nullable(),
    fatherEmail: z.string().nullable(),
    fatherOccupation: z.string().nullable(),
    motherName: z.string().nullable(),
    motherPhone: z.string().nullable(),
    motherEmail: z.string().nullable(),
    motherOccupation: z.string().nullable(),
    primaryGuardianId: id('902').nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    cityId: id('1').nullable(),
    postalCode: z.string().nullable(),
    studentHouseId: id('905').nullable(),
    status: z.enum(['active', 'inactive', 'alumni', 'transferred_out', 'expelled']),
    admittedOn: z.string(),
    leftOn: z.string().nullable(),
    leftReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Student');

// { success: true, data, meta? } - the envelope the frontend's apiClient expects.
export const envelope = <T extends z.ZodTypeAny>(name: string, data: T) =>
  z.object({ success: z.literal(true), data }).openapi(name);

export const pagedEnvelope = <T extends z.ZodTypeAny>(name: string, item: T) =>
  z.object({ success: z.literal(true), data: z.array(item), meta: PageMeta }).openapi(name);
