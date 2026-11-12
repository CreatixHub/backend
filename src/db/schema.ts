import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  smallint,
  time,
  check,
} from "drizzle-orm/pg-core";
// Every bigint/bigserial id column uses { mode: "bigint" } so the app keeps working with real JS BigInt
// values everywhere (lib/bigint.ts already teaches JSON.stringify to serialize them) - same shape the
// Prisma schema used.
const idCol = () => bigserial("id", { mode: "bigint" }).primaryKey();
const plainBigint = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 6, mode: "date" });
const createdAt = () => ts("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);
// Matches Prisma's @updatedAt: set once on insert, bumped automatically on every .update() issued through Drizzle.
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => new Date());

export const organizations = pgTable(
  "organizations",
  {
    id: idCol(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("organizations_slug_key").on(t.slug)],
);

export const users = pgTable(
  "users",
  {
    id: idCol(),
    username: text("username"),
    email: text("email"),
    phone: text("phone"),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash"),
    userType: text("user_type").notNull().default("staff"), // student | guardian | staff | admin | owner
    status: text("status").notNull().default("active"), // active | invited | suspended | deleted
    avatarUrl: text("avatar_url"),
    avatarFileId: plainBigint("avatar_file_id"), // files table not built yet
    languageId: plainBigint("language_id"), // languages table not built yet
    timezone: text("timezone"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    invitedAt: ts("invited_at"),
    emailVerifiedAt: ts("email_verified_at"),
    phoneVerifiedAt: ts("phone_verified_at"),
    lastLoginAt: ts("last_login_at"),
    lastLoginIp: inet("last_login_ip"),
    failedLoginCount: smallint("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    passwordChangedAt: ts("password_changed_at"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    deletedBy: plainBigint("deleted_by").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("users_username_key").on(t.username),
    uniqueIndex("users_email_key").on(t.email),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    userId: plainBigint("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("memberships_user_id_idx").on(t.userId),
    uniqueIndex("memberships_tenant_id_user_id_key").on(t.tenantId, t.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("roles_tenant_id_code_key").on(t.tenantId, t.code)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: idCol(),
    code: text("code").notNull(),
    module: text("module").notNull(),
    action: text("action").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("permissions_code_key").on(t.code)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: plainBigint("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade", onUpdate: "cascade" }),
    permissionId: plainBigint("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "restrict", onUpdate: "cascade" }),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    membershipId: plainBigint("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade", onUpdate: "cascade" }),
    roleId: plainBigint("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.roleId] }),
    index("membership_roles_tenant_id_idx").on(t.tenantId),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: idCol(),
    userId: plainBigint("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tenantId: plainBigint("tenant_id").references(() => organizations.id, { onDelete: "set null", onUpdate: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_token_hash_key").on(t.tokenHash),
    index("refresh_tokens_family_id_idx").on(t.familyId),
    index("refresh_tokens_user_id_idx").on(t.userId),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id").references(() => organizations.id, { onDelete: "set null", onUpdate: "cascade" }),
    // no FK on actor_id in the original Prisma schema either - kept unconstrained to match
    actorId: plainBigint("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_tenant_id_created_at_idx").on(t.tenantId, t.createdAt)],
);


// Staff: ONE table for teaching and non-teaching staff, told apart by staff_type (spec section 3).
// Columns ending in _enc hold ENCRYPTED text: never log them or return them in plain form.
export const staff = pgTable(
  "staff",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    // Spec: branch_id FK -> branches, NOT NULL. The branches table does not exist yet, so it is optional here.
    branchId: plainBigint("branch_id"),
    employeeNo: text("employee_no").notNull(),
    userId: plainBigint("user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    staffType: text("staff_type").notNull(), // teaching | non_teaching
    employmentType: text("employment_type").notNull(), // full_time | part_time | contract | visiting
    // No FK yet: departments / designations tables are not built.
    departmentId: plainBigint("department_id"),
    designationId: plainBigint("designation_id"),
    reportsToId: plainBigint("reports_to_id").references((): AnyPgColumn => staff.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    status: text("status").notNull().default("active"), // active | on_leave | suspended | left

    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    dob: date("dob"),
    gender: text("gender"),
    bloodGroup: text("blood_group"),
    maritalStatus: text("marital_status"),
    fatherName: text("father_name"),
    motherTongueId: plainBigint("mother_tongue_id"), // languages table not built yet

    email: text("email"),
    phone: text("phone"),
    altPhone: text("alt_phone"),

    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    cityId: plainBigint("city_id"), // cities table not built yet
    postalCode: text("postal_code"),
    permanentAddressSame: boolean("permanent_address_same").notNull().default(false),
    permanentAddressLine1: text("permanent_address_line1"),
    permanentAddressLine2: text("permanent_address_line2"),
    permanentCityId: plainBigint("permanent_city_id"),
    permanentPostalCode: text("permanent_postal_code"),

    joinedOn: date("joined_on").notNull(),
    probationEndsOn: date("probation_ends_on"),
    confirmedOn: date("confirmed_on"),
    leftOn: date("left_on"),
    leftReason: text("left_reason"),

    qualification: text("qualification"),
    experienceYears: numeric("experience_years", { precision: 4, scale: 1 }),

    nationalIdEnc: text("national_id_enc"), // encrypted at rest
    panEnc: text("pan_enc"), // encrypted at rest
    epfNo: text("epf_no"),
    bankAccountName: text("bank_account_name"),
    bankName: text("bank_name"),
    bankBranch: text("bank_branch"),
    bankIfsc: text("bank_ifsc"),
    bankMicr: text("bank_micr"),
    bankAccountEnc: text("bank_account_enc"), // encrypted at rest

    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    photoFileId: plainBigint("photo_file_id"), // files table not built yet
    socialLinks: jsonb("social_links").$type<Record<string, string>>().notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    uniqueIndex("staff_tenant_id_employee_no_key").on(t.tenantId, t.employeeNo),
    index("staff_tenant_id_status_idx").on(t.tenantId, t.status),
    index("staff_user_id_idx").on(t.userId),
    index("staff_reports_to_id_idx").on(t.reportsToId),
  ],
);
// ---------------------------------------------------------------- relations (for the `db.query.*` API)

// Subjects: the subject catalogue (spec section 4). Linking subjects to classes (class_subjects) comes with the Classes task.
export const subjects = pgTable(
  "subjects",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    subjectType: text("subject_type").notNull(), // core | elective | co_curricular | language
    credits: numeric("credits", { precision: 4, scale: 1 }),
    color: text("color"), // for timetable / UI display, e.g. "#3B82F6"
    departmentId: plainBigint("department_id"), // departments table not built yet, so no FK
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    // the code is unique per school, but a deleted subject's code can be used again
    uniqueIndex("subjects_tenant_id_code_key").on(t.tenantId, t.code).where(sql`${t.deletedAt} IS NULL`),
    index("subjects_tenant_id_status_idx").on(t.tenantId, t.status),
  ],
);

// Classes, sections and classrooms (spec section 5). branch_id is optional because the branches table is not built yet.
export const classes = pgTable(
  "classes",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    branchId: plainBigint("branch_id"),
    gradeLevel: smallint("grade_level").notNull(), // numeric order for sorting, e.g. 1-12
    name: text("name").notNull(), // e.g. "Grade 10"
    code: text("code").notNull(),
    stream: text("stream"), // e.g. Science / Commerce / Arts, for senior grades
    category: text("category"),
    displayOrder: smallint("display_order").notNull().default(0),
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    uniqueIndex("classes_tenant_id_code_key").on(t.tenantId, t.code).where(sql`${t.deletedAt} IS NULL`),
    index("classes_tenant_id_status_idx").on(t.tenantId, t.status),
  ],
);

export const classrooms = pgTable(
  "classrooms",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    branchId: plainBigint("branch_id"),
    code: text("code").notNull(),
    name: text("name"),
    building: text("building"),
    floor: smallint("floor"),
    capacity: smallint("capacity"),
    roomType: text("room_type").notNull().default("classroom"), // classroom | lab | hall | staff_room | other
    status: text("status").notNull().default("active"),
    facilities: text("facilities").array().notNull().default(sql`'{}'::text[]`), // e.g. projector, ac, smartboard
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    uniqueIndex("classrooms_tenant_id_code_key").on(t.tenantId, t.code).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const sections = pgTable(
  "sections",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    classId: plainBigint("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(), // e.g. "A"
    capacity: smallint("capacity").notNull(),
    defaultClassroomId: plainBigint("default_classroom_id").references(() => classrooms.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    shift: text("shift").notNull().default("morning"), // morning | afternoon | evening
    medium: text("medium"), // language of instruction
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  },
  (t) => [
    uniqueIndex("sections_class_id_name_key").on(t.classId, t.name).where(sql`${t.deletedAt} IS NULL`),
    index("sections_tenant_id_class_id_idx").on(t.tenantId, t.classId),
  ],
);

// Which subjects a class teaches, and the marks setup for each (spec section 4).
export const classSubjects = pgTable(
  "class_subjects",
  {
    classId: plainBigint("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade", onUpdate: "cascade" }),
    subjectId: plainBigint("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    isElective: boolean("is_elective").notNull().default(false),
    periodsPerWeek: smallint("periods_per_week"),
    displayOrder: smallint("display_order").notNull().default(0),
    examMarks: numeric("exam_marks", { precision: 6, scale: 2 }).notNull(),
    internalMarks: numeric("internal_marks", { precision: 6, scale: 2 }).notNull(),
    passMarks: numeric("pass_marks", { precision: 6, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.classId, t.subjectId] }),
    index("class_subjects_tenant_id_idx").on(t.tenantId),
  ],
);

// Timetable (spec section 7). academic_years is not built yet, so academic_year_id has no FK for now.
export const timeSlots = pgTable(
  "time_slots",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    branchId: plainBigint("branch_id"), // branches table not built yet
    name: text("name").notNull(), // "Period 1", "Lunch"
    sequence: smallint("sequence").notNull(), // 1, 2, 3 ... order within the day
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    isBreak: boolean("is_break").notNull().default(false),
    durationMinutes: integer("duration_minutes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("time_slots_tenant_id_sequence_key").on(t.tenantId, t.sequence)],
);

// Which teacher takes which subject for a section, for one academic year.
export const sectionTeachers = pgTable(
  "section_teachers",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sectionId: plainBigint("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "restrict", onUpdate: "cascade" }),
    subjectId: plainBigint("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    academicYearId: plainBigint("academic_year_id").notNull(), // academic_years table not built yet
    teacherId: plainBigint("teacher_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("section_teachers_section_subject_year_key").on(t.sectionId, t.subjectId, t.academicYearId),
    index("section_teachers_tenant_id_teacher_id_idx").on(t.tenantId, t.teacherId),
  ],
);

// The actual weekly grid: on this day, in this time slot, this section has this subject with this teacher, in this room.
export const timetableEntries = pgTable(
  "timetable_entries",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sectionId: plainBigint("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "restrict", onUpdate: "cascade" }),
    subjectId: plainBigint("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    teacherId: plainBigint("teacher_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict", onUpdate: "cascade" }),
    timeSlotId: plainBigint("time_slot_id")
      .notNull()
      .references(() => timeSlots.id, { onDelete: "restrict", onUpdate: "cascade" }),
    classroomId: plainBigint("classroom_id").references(() => classrooms.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    dayOfWeek: smallint("day_of_week").notNull(), // 1 (Mon) - 7 (Sun)
    academicYearId: plainBigint("academic_year_id").notNull(), // academic_years table not built yet
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("timetable_entries_section_day_idx").on(t.tenantId, t.sectionId, t.dayOfWeek),
    index("timetable_entries_teacher_day_idx").on(t.tenantId, t.teacherId, t.dayOfWeek),
    index("timetable_entries_classroom_idx").on(t.classroomId),
    index("timetable_entries_time_slot_idx").on(t.timeSlotId),
  ],
);

// LMS (Basic): homework + submissions (spec section 8).
// enrollments, files and academic_years are not built yet, so enrollment_id / file_id / academic_year_id have no FK for now.
export const homework = pgTable(
  "homework",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    homeworkCode: text("homework_code").notNull(),
    sectionId: plainBigint("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "restrict", onUpdate: "cascade" }),
    subjectId: plainBigint("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    teacherId: plainBigint("teacher_id")
      .notNull()
      .references(() => staff.id, { onDelete: "restrict", onUpdate: "cascade" }),
    academicYearId: plainBigint("academic_year_id").notNull(), // academic_years table not built yet
    title: text("title").notNull(),
    description: text("description"),
    homeworkType: text("homework_type").notNull().default("assignment"), // assignment | project | reading | practice
    priority: text("priority").notNull().default("normal"), // low | normal | high
    durationMinutes: smallint("duration_minutes"),
    assignedOn: date("assigned_on").notNull(),
    dueAt: ts("due_at").notNull(),
    maxMarks: numeric("max_marks", { precision: 5, scale: 2 }),
    submissionRequired: boolean("submission_required").notNull().default(true),
    allowLate: boolean("allow_late").notNull().default(false),
    latePenaltyPercent: numeric("late_penalty_percent", { precision: 5, scale: 2 }),
    submissionType: text("submission_type").notNull().default("text"), // text | file | both
    status: text("status").notNull().default("draft"), // draft | published | closed
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("homework_tenant_id_homework_code_key").on(t.tenantId, t.homeworkCode),
    index("homework_tenant_id_section_id_due_at_idx").on(t.tenantId, t.sectionId, t.dueAt),
    index("homework_tenant_id_teacher_id_idx").on(t.tenantId, t.teacherId),
  ],
);

export const homeworkSubmissions = pgTable(
  "homework_submissions",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    homeworkId: plainBigint("homework_id")
      .notNull()
      .references(() => homework.id, { onDelete: "restrict", onUpdate: "cascade" }),
    enrollmentId: plainBigint("enrollment_id").notNull(), // enrollments table not built yet
    submittedAt: ts("submitted_at"),
    textAnswer: text("text_answer"),
    fileId: plainBigint("file_id"), // files table not built yet
    status: text("status").notNull().default("not_submitted"), // not_submitted | submitted | late | graded
    score: numeric("score", { precision: 5, scale: 2 }),
    gradeLabel: text("grade_label"),
    feedback: text("feedback"),
    gradedBy: plainBigint("graded_by").references(() => staff.id, { onDelete: "set null", onUpdate: "cascade" }),
    gradedAt: ts("graded_at"),
    resubmissionRequired: boolean("resubmission_required").notNull().default(false),
    lateReason: text("late_reason"),
    marksDeducted: numeric("marks_deducted", { precision: 5, scale: 2 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // one row per student per homework: a resubmission updates the same row
    uniqueIndex("homework_submissions_homework_id_enrollment_id_key").on(t.homeworkId, t.enrollmentId),
    index("homework_submissions_tenant_id_enrollment_id_idx").on(t.tenantId, t.enrollmentId),
  ],
);

// File links (the upload API comes with the files module).
export const homeworkAttachments = pgTable(
  "homework_attachments",
  {
    homeworkId: plainBigint("homework_id")
      .notNull()
      .references(() => homework.id, { onDelete: "cascade", onUpdate: "cascade" }),
    fileId: plainBigint("file_id").notNull(), // files table not built yet
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.homeworkId, t.fileId] })],
);

export const homeworkSubmissionFiles = pgTable(
  "homework_submission_files",
  {
    submissionId: plainBigint("submission_id")
      .notNull()
      .references(() => homeworkSubmissions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    fileId: plainBigint("file_id").notNull(), // files table not built yet
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.fileId] })],
);

// Transport (spec section 11). branches, academic_years and students are not built yet, so those ids have no FK for now.
export const vehicles = pgTable(
  "vehicles",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    branchId: plainBigint("branch_id"), // branches table not built yet
    registrationNo: text("registration_no").notNull(),
    vehicleType: text("vehicle_type").notNull(), // bus | van | car
    seatingCapacity: smallint("seating_capacity").notNull(),
    insuranceExpiry: date("insurance_expiry"),
    fitnessExpiry: date("fitness_expiry"),
    permitExpiry: date("permit_expiry"),
    pollutionExpiry: date("pollution_expiry"),
    gpsDeviceId: text("gps_device_id"),
    // extra ERD columns named in the spec note: check these against the ERD
    chassisNo: text("chassis_no"),
    engineNo: text("engine_no"),
    make: text("make"),
    model: text("model"),
    manufactureYear: smallint("manufacture_year"),
    odometerKm: integer("odometer_km"),
    status: text("status").notNull().default("active"), // active | maintenance | retired
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("vehicles_tenant_id_registration_no_key").on(t.tenantId, t.registrationNo),
    index("vehicles_tenant_id_status_idx").on(t.tenantId, t.status),
  ],
);

export const transportRoutes = pgTable(
  "transport_routes",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    branchId: plainBigint("branch_id"),
    code: text("code").notNull(),
    name: text("name").notNull(), // e.g. "Route 4 - Lakeside"
    startLocation: text("start_location"),
    endLocation: text("end_location"),
    distanceKm: numeric("distance_km", { precision: 6, scale: 2 }),
    estimatedMinutes: smallint("estimated_minutes"),
    shift: text("shift").notNull().default("morning"), // morning | afternoon | both
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("transport_routes_tenant_id_code_key").on(t.tenantId, t.code)],
);

// A stop on a route, with its own monthly fee.
export const pickupPoints = pgTable(
  "pickup_points",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    routeId: plainBigint("route_id")
      .notNull()
      .references(() => transportRoutes.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(),
    sequence: smallint("sequence").notNull(), // order of the stop along the route
    landmark: text("landmark"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    pickupTime: time("pickup_time"),
    dropTime: time("drop_time"),
    monthlyFee: numeric("monthly_fee", { precision: 12, scale: 2 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pickup_points_route_id_sequence_key").on(t.routeId, t.sequence),
    index("pickup_points_tenant_id_route_id_idx").on(t.tenantId, t.routeId),
  ],
);

// A driver may or may not also be a staff member (staff_id is null for an outsourced driver).
export const drivers = pgTable(
  "drivers",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    staffId: plainBigint("staff_id").references(() => staff.id, { onDelete: "set null", onUpdate: "cascade" }),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    licenseNo: text("license_no").notNull(),
    licenseExpiry: date("license_expiry").notNull(),
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("drivers_tenant_id_license_no_key").on(t.tenantId, t.licenseNo)],
);

// Which vehicle + driver runs a route, in which shift, on which days.
export const routeSchedules = pgTable(
  "route_schedules",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    routeId: plainBigint("route_id")
      .notNull()
      .references(() => transportRoutes.id, { onDelete: "restrict", onUpdate: "cascade" }),
    vehicleId: plainBigint("vehicle_id")
      .notNull()
      .references(() => vehicles.id, { onDelete: "restrict", onUpdate: "cascade" }),
    driverId: plainBigint("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict", onUpdate: "cascade" }),
    attendantStaffId: plainBigint("attendant_staff_id").references(() => staff.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    shift: text("shift").notNull(), // morning | afternoon
    operatingDays: smallint("operating_days").array().notNull(), // 1 (Mon) - 7 (Sun)
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("route_schedules_tenant_id_route_id_idx").on(t.tenantId, t.routeId),
    index("route_schedules_vehicle_id_idx").on(t.vehicleId),
    index("route_schedules_driver_id_idx").on(t.driverId),
  ],
);

// A student OR a staff member riding a route from a pickup point.
export const transportAssignments = pgTable(
  "transport_assignments",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    studentId: plainBigint("student_id").references((): AnyPgColumn => students.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    staffId: plainBigint("staff_id").references(() => staff.id, { onDelete: "restrict", onUpdate: "cascade" }),
    academicYearId: plainBigint("academic_year_id").notNull(), // academic_years table not built yet
    routeId: plainBigint("route_id")
      .notNull()
      .references(() => transportRoutes.id, { onDelete: "restrict", onUpdate: "cascade" }),
    pickupPointId: plainBigint("pickup_point_id")
      .notNull()
      .references(() => pickupPoints.id, { onDelete: "restrict", onUpdate: "cascade" }),
    direction: text("direction").notNull().default("both"), // pickup | drop | both
    monthlyFee: numeric("monthly_fee", { precision: 12, scale: 2 }).notNull(),
    status: text("status").notNull().default("active"), // active | ended
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("transport_assignments_tenant_id_route_id_year_idx").on(t.tenantId, t.routeId, t.academicYearId),
    index("transport_assignments_tenant_id_student_id_idx").on(t.tenantId, t.studentId),
    index("transport_assignments_tenant_id_staff_id_idx").on(t.tenantId, t.staffId),
  ],
);

// ================================================================ ASSETS (spec §12)
// vendors and branches tables do not exist yet -> plain bigint columns, no FK.

export const assetCategories = pgTable(
  'asset_categories',
  {
    id: idCol(),
    tenantId: plainBigint('tenant_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    parentId: plainBigint('parent_id').references((): AnyPgColumn => assetCategories.id),
    depreciationMethod: text('depreciation_method').notNull().default('none'), // straight_line | declining_balance | none
    usefulLifeYears: smallint('useful_life_years'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('asset_categories_tenant_name_uq').on(t.tenantId, t.name)],
);

export const assets = pgTable(
  'assets',
  {
    id: idCol(),
    tenantId: plainBigint('tenant_id')
      .notNull()
      .references(() => organizations.id),
    assetTag: text('asset_tag').notNull(),
    name: text('name').notNull(),
    categoryId: plainBigint('category_id')
      .notNull()
      .references(() => assetCategories.id),
    vendorId: plainBigint('vendor_id'), // no FK: vendors table not built yet
    branchId: plainBigint('branch_id'), // no FK: branches table not built yet
    quantity: integer('quantity').notNull().default(1),
    serialNo: text('serial_no'),
    model: text('model'),
    purchaseDate: date('purchase_date'),
    purchaseCost: numeric('purchase_cost', { precision: 12, scale: 2 }),
    warrantyUntil: date('warranty_until'),
    salvageValue: numeric('salvage_value', { precision: 12, scale: 2 }),
    locationClassroomId: plainBigint('location_classroom_id').references(() => classrooms.id),
    status: text('status').notNull().default('in_store'), // in_use | in_store | under_repair | retired | disposed
    condition: text('condition').notNull().default('good'), // new | good | fair | poor
    disposedOn: date('disposed_on'),
    disposalValue: numeric('disposal_value', { precision: 12, scale: 2 }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('assets_tenant_tag_uq').on(t.tenantId, t.assetTag),
    index('assets_tenant_status_idx').on(t.tenantId, t.status),
    index('assets_tenant_category_idx').on(t.tenantId, t.categoryId),
  ],
);

export const assetAllocations = pgTable(
  'asset_allocations',
  {
    id: idCol(),
    tenantId: plainBigint('tenant_id')
      .notNull()
      .references(() => organizations.id),
    assetId: plainBigint('asset_id')
      .notNull()
      .references(() => assets.id),
    staffId: plainBigint('staff_id').references(() => staff.id),
    studentId: plainBigint('student_id').references((): AnyPgColumn => students.id),
    classroomId: plainBigint('classroom_id').references(() => classrooms.id),
    allocatedOn: date('allocated_on'),
    expectedReturnOn: date('expected_return_on'),
    returnedOn: date('returned_on'), // NULL = still allocated
    conditionOut: text('condition_out'),
    conditionIn: text('condition_in'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // an allocation goes to exactly one of staff / student / classroom
    check(
      'asset_allocations_one_target',
      sql`(${t.staffId} IS NOT NULL)::int + (${t.studentId} IS NOT NULL)::int + (${t.classroomId} IS NOT NULL)::int = 1`,
    ),
    // an asset has at most one open (not yet returned) allocation
    uniqueIndex('asset_allocations_one_open_uq')
      .on(t.assetId)
      .where(sql`${t.returnedOn} IS NULL`),
    index('asset_allocations_tenant_staff_idx').on(t.tenantId, t.staffId),
    index('asset_allocations_tenant_classroom_idx').on(t.tenantId, t.classroomId),
  ],
);

export const assetMaintenance = pgTable(
  'asset_maintenance',
  {
    id: idCol(),
    tenantId: plainBigint('tenant_id')
      .notNull()
      .references(() => organizations.id),
    assetId: plainBigint('asset_id')
      .notNull()
      .references(() => assets.id),
    maintenanceType: text('maintenance_type').notNull(), // scheduled | repair | inspection
    description: text('description'),
    reportedOn: date('reported_on'),
    startedOn: date('started_on'),
    completedOn: date('completed_on'),
    cost: numeric('cost', { precision: 12, scale: 2 }),
    labourCost: numeric('labour_cost', { precision: 12, scale: 2 }),
    partsCost: numeric('parts_cost', { precision: 12, scale: 2 }),
    vendorId: plainBigint('vendor_id'), // no FK: vendors table not built yet
    status: text('status').notNull().default('reported'), // reported | in_progress | completed | cancelled
    nextDueOn: date('next_due_on'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('asset_maintenance_tenant_asset_idx').on(t.tenantId, t.assetId),
    index('asset_maintenance_tenant_due_idx').on(t.tenantId, t.nextDueOn),
  ],
);

// ================================================================ ADMISSIONS (spec §1) & STUDENTS (spec §2)
// academic_years, religions, cities, languages and files tables do not exist yet -> plain bigint columns, no FK.

export const studentHouses = pgTable(
  "student_houses",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    motto: text("motto"),
    houseMasterId: plainBigint("house_master_id").references(() => staff.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    isActive: boolean("is_active").notNull().default(true),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("student_houses_tenant_id_name_key")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const guardians = pgTable(
  "guardians",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    fullName: text("full_name").notNull(),
    relation: text("relation").notNull(), // father | mother | guardian | other
    phone: text("phone").notNull(),
    altPhone: text("alt_phone"),
    email: text("email"),
    occupation: text("occupation"),
    annualIncome: numeric("annual_income", { precision: 12, scale: 2 }),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    cityId: plainBigint("city_id"), // cities table not built yet
    postalCode: text("postal_code"),
    photoFileId: plainBigint("photo_file_id"), // files table not built yet
    idProofType: text("id_proof_type"),
    idProofNo: text("id_proof_no"),
    isEmergencyContact: boolean("is_emergency_contact").notNull().default(false),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("guardians_tenant_id_phone_idx").on(t.tenantId, t.phone)],
);

export const students = pgTable(
  "students",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    userId: plainBigint("user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    admissionId: plainBigint("admission_id").references((): AnyPgColumn => admissions.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    admissionNo: text("admission_no").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    fullName: text("full_name"),
    dob: date("dob").notNull(),
    gender: text("gender"),
    bloodGroup: text("blood_group"),
    religionId: plainBigint("religion_id"), // religions table not built yet
    socialCategory: text("social_category"),
    motherTongueId: plainBigint("mother_tongue_id"), // languages table not built yet
    photoFileId: plainBigint("photo_file_id"), // files table not built yet
    fatherName: text("father_name"),
    fatherPhone: text("father_phone"),
    fatherEmail: text("father_email"),
    fatherOccupation: text("father_occupation"),
    motherName: text("mother_name"),
    motherPhone: text("mother_phone"),
    motherEmail: text("mother_email"),
    motherOccupation: text("mother_occupation"),
    primaryGuardianId: plainBigint("primary_guardian_id").references(() => guardians.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    cityId: plainBigint("city_id"), // cities table not built yet
    postalCode: text("postal_code"),
    studentHouseId: plainBigint("student_house_id").references(() => studentHouses.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    status: text("status").notNull().default("active"), // active | inactive | alumni | transferred_out | expelled
    admittedOn: date("admitted_on").notNull(),
    leftOn: date("left_on"),
    leftReason: text("left_reason"),
    deletedBy: plainBigint("deleted_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("students_tenant_id_admission_no_key").on(t.tenantId, t.admissionNo),
    uniqueIndex("students_admission_id_key").on(t.admissionId),
    index("students_tenant_id_status_idx").on(t.tenantId, t.status),
    index("students_tenant_id_student_house_id_idx").on(t.tenantId, t.studentHouseId),
    index("students_user_id_idx").on(t.userId),
  ],
);

export const studentGuardians = pgTable(
  "student_guardians",
  {
    studentId: plainBigint("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade", onUpdate: "cascade" }),
    guardianId: plainBigint("guardian_id")
      .notNull()
      .references(() => guardians.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    canPickUp: boolean("can_pick_up").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.guardianId] }),
    index("student_guardians_tenant_id_idx").on(t.tenantId),
    index("student_guardians_guardian_id_idx").on(t.guardianId),
  ],
);

export const studentDocuments = pgTable(
  "student_documents",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    studentId: plainBigint("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade", onUpdate: "cascade" }),
    documentType: text("document_type").notNull(),
    fileId: plainBigint("file_id").notNull(), // files table not built yet
    documentNo: text("document_no"),
    issuedOn: date("issued_on"),
    expiresOn: date("expires_on"),
    verifiedStatus: text("verified_status").notNull().default("pending"), // pending | verified | rejected
    verifiedBy: plainBigint("verified_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    verifiedAt: ts("verified_at"),
    remarks: text("remarks"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("student_documents_tenant_id_student_id_idx").on(t.tenantId, t.studentId)],
);

export const admissions = pgTable(
  "admissions",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    applicationNo: text("application_no").notNull(),
    academicYearId: plainBigint("academic_year_id").notNull(), // academic_years table not built yet
    classId: plainBigint("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "restrict", onUpdate: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    dob: date("dob").notNull(),
    gender: text("gender"),
    email: text("email"),
    phone: text("phone"),
    bloodGroup: text("blood_group"),
    religionId: plainBigint("religion_id"), // religions table not built yet
    socialCategory: text("social_category"),
    fatherName: text("father_name"),
    fatherPhone: text("father_phone"),
    fatherEmail: text("father_email"),
    fatherOccupation: text("father_occupation"),
    motherName: text("mother_name"),
    motherPhone: text("mother_phone"),
    motherEmail: text("mother_email"),
    motherOccupation: text("mother_occupation"),
    guardianName: text("guardian_name").notNull(),
    guardianPhone: text("guardian_phone").notNull(),
    guardianEmail: text("guardian_email"),
    previousSchool: text("previous_school"),
    previousClass: text("previous_class"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    cityId: plainBigint("city_id"), // cities table not built yet
    postalCode: text("postal_code"),
    status: text("status").notNull().default("applied"), // enquiry | applied | document_review | shortlisted | waitlisted | offered | accepted | rejected | withdrawn
    appliedOn: date("applied_on").notNull(),
    acknowledgedAt: ts("acknowledged_at"),
    decisionOn: date("decision_on"),
    decidedBy: plainBigint("decided_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    decisionNotes: text("decision_notes"),
    rejectionReason: text("rejection_reason"),
    waitlistPosition: smallint("waitlist_position"),
    assignedToStaffId: plainBigint("assigned_to_staff_id").references(() => staff.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    needsTransport: boolean("needs_transport").notNull().default(false),
    needsHostel: boolean("needs_hostel").notNull().default(false),
    applicationFee: numeric("application_fee", { precision: 12, scale: 2 }),
    feePaid: boolean("fee_paid").notNull().default(false),
    feePaidOn: date("fee_paid_on"),
    feePaymentMethod: text("fee_payment_method"),
    source: text("source").notNull(), // walk_in | website | referral | agent | event | other
    studentId: plainBigint("student_id").references(() => students.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("admissions_tenant_id_application_no_key").on(t.tenantId, t.applicationNo),
    uniqueIndex("admissions_student_id_key").on(t.studentId),
    index("admissions_tenant_id_academic_year_id_idx").on(t.tenantId, t.academicYearId),
    index("admissions_tenant_id_class_id_idx").on(t.tenantId, t.classId),
    index("admissions_tenant_id_status_idx").on(t.tenantId, t.status),
  ],
);

export const admissionStatusHistory = pgTable(
  "admission_status_history",
  {
    id: idCol(),
    tenantId: plainBigint("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict", onUpdate: "cascade" }),
    admissionId: plainBigint("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "cascade", onUpdate: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    changedBy: plainBigint("changed_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("admission_status_history_tenant_id_admission_id_idx").on(t.tenantId, t.admissionId)],
);

export const assetCategoriesRelations = relations(assetCategories, ({ one, many }) => ({
  parent: one(assetCategories, {
    fields: [assetCategories.parentId],
    references: [assetCategories.id],
    relationName: 'assetCategoryParent',
  }),
  children: many(assetCategories, { relationName: 'assetCategoryParent' }),
  assets: many(assets),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  category: one(assetCategories, { fields: [assets.categoryId], references: [assetCategories.id] }),
  classroom: one(classrooms, { fields: [assets.locationClassroomId], references: [classrooms.id] }),
  allocations: many(assetAllocations),
  maintenance: many(assetMaintenance),
}));

export const assetAllocationsRelations = relations(assetAllocations, ({ one }) => ({
  asset: one(assets, { fields: [assetAllocations.assetId], references: [assets.id] }),
  staff: one(staff, { fields: [assetAllocations.staffId], references: [staff.id] }),
  student: one(students, { fields: [assetAllocations.studentId], references: [students.id] }),
  classroom: one(classrooms, { fields: [assetAllocations.classroomId], references: [classrooms.id] }),
}));

export const assetMaintenanceRelations = relations(assetMaintenance, ({ one }) => ({
  asset: one(assets, { fields: [assetMaintenance.assetId], references: [assets.id] }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  roles: many(roles),
  rolePermissions: many(rolePermissions),
  membershipRoles: many(membershipRoles),
  refreshTokens: many(refreshTokens),
  auditLogs: many(auditLog),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  deletedByUser: one(users, {
    fields: [users.deletedBy],
    references: [users.id],
    relationName: "userDeletedBy",
  }),
  memberships: many(memberships),
  refreshTokens: many(refreshTokens),
}));

export const membershipsRelations = relations(memberships, ({ one, many }) => ({
  tenant: one(organizations, { fields: [memberships.tenantId], references: [organizations.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  roles: many(membershipRoles),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  tenant: one(organizations, { fields: [roles.tenantId], references: [organizations.id] }),
  rolePermissions: many(rolePermissions),
  membershipRoles: many(membershipRoles),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, { fields: [rolePermissions.permissionId], references: [permissions.id] }),
  tenant: one(organizations, { fields: [rolePermissions.tenantId], references: [organizations.id] }),
}));

export const membershipRolesRelations = relations(membershipRoles, ({ one }) => ({
  membership: one(memberships, { fields: [membershipRoles.membershipId], references: [memberships.id] }),
  role: one(roles, { fields: [membershipRoles.roleId], references: [roles.id] }),
  tenant: one(organizations, { fields: [membershipRoles.tenantId], references: [organizations.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
  tenant: one(organizations, { fields: [refreshTokens.tenantId], references: [organizations.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  tenant: one(organizations, { fields: [auditLog.tenantId], references: [organizations.id] }),
}));


export const staffRelations = relations(staff, ({ one }) => ({
  tenant: one(organizations, { fields: [staff.tenantId], references: [organizations.id] }),
  user: one(users, { fields: [staff.userId], references: [users.id] }),
}));

export const subjectsRelations = relations(subjects, ({ one }) => ({
  tenant: one(organizations, { fields: [subjects.tenantId], references: [organizations.id] }),
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
  tenant: one(organizations, { fields: [classes.tenantId], references: [organizations.id] }),
  sections: many(sections),
  classSubjects: many(classSubjects),
}));

export const sectionsRelations = relations(sections, ({ one }) => ({
  class: one(classes, { fields: [sections.classId], references: [classes.id] }),
  defaultClassroom: one(classrooms, { fields: [sections.defaultClassroomId], references: [classrooms.id] }),
}));

export const classSubjectsRelations = relations(classSubjects, ({ one }) => ({
  class: one(classes, { fields: [classSubjects.classId], references: [classes.id] }),
  subject: one(subjects, { fields: [classSubjects.subjectId], references: [subjects.id] }),
}));

export const sectionTeachersRelations = relations(sectionTeachers, ({ one }) => ({
  section: one(sections, { fields: [sectionTeachers.sectionId], references: [sections.id] }),
  subject: one(subjects, { fields: [sectionTeachers.subjectId], references: [subjects.id] }),
  teacher: one(staff, { fields: [sectionTeachers.teacherId], references: [staff.id] }),
}));

export const timetableEntriesRelations = relations(timetableEntries, ({ one }) => ({
  section: one(sections, { fields: [timetableEntries.sectionId], references: [sections.id] }),
  subject: one(subjects, { fields: [timetableEntries.subjectId], references: [subjects.id] }),
  teacher: one(staff, { fields: [timetableEntries.teacherId], references: [staff.id] }),
  timeSlot: one(timeSlots, { fields: [timetableEntries.timeSlotId], references: [timeSlots.id] }),
  classroom: one(classrooms, { fields: [timetableEntries.classroomId], references: [classrooms.id] }),
}));

export const homeworkRelations = relations(homework, ({ one, many }) => ({
  section: one(sections, { fields: [homework.sectionId], references: [sections.id] }),
  subject: one(subjects, { fields: [homework.subjectId], references: [subjects.id] }),
  teacher: one(staff, { fields: [homework.teacherId], references: [staff.id] }),
  submissions: many(homeworkSubmissions),
}));

export const homeworkSubmissionsRelations = relations(homeworkSubmissions, ({ one }) => ({
  homework: one(homework, { fields: [homeworkSubmissions.homeworkId], references: [homework.id] }),
}));

export const transportRoutesRelations = relations(transportRoutes, ({ many }) => ({
  pickupPoints: many(pickupPoints),
  schedules: many(routeSchedules),
}));

export const pickupPointsRelations = relations(pickupPoints, ({ one }) => ({
  route: one(transportRoutes, { fields: [pickupPoints.routeId], references: [transportRoutes.id] }),
}));

export const routeSchedulesRelations = relations(routeSchedules, ({ one }) => ({
  route: one(transportRoutes, { fields: [routeSchedules.routeId], references: [transportRoutes.id] }),
  vehicle: one(vehicles, { fields: [routeSchedules.vehicleId], references: [vehicles.id] }),
  driver: one(drivers, { fields: [routeSchedules.driverId], references: [drivers.id] }),
}));

export const transportAssignmentsRelations = relations(transportAssignments, ({ one }) => ({
  route: one(transportRoutes, { fields: [transportAssignments.routeId], references: [transportRoutes.id] }),
  pickupPoint: one(pickupPoints, { fields: [transportAssignments.pickupPointId], references: [pickupPoints.id] }),
  student: one(students, { fields: [transportAssignments.studentId], references: [students.id] }),
  staff: one(staff, { fields: [transportAssignments.staffId], references: [staff.id] }),
}));

export const studentHousesRelations = relations(studentHouses, ({ one, many }) => ({
  tenant: one(organizations, { fields: [studentHouses.tenantId], references: [organizations.id] }),
  houseMaster: one(staff, { fields: [studentHouses.houseMasterId], references: [staff.id] }),
  students: many(students),
}));

export const guardiansRelations = relations(guardians, ({ one, many }) => ({
  tenant: one(organizations, { fields: [guardians.tenantId], references: [organizations.id] }),
  studentGuardians: many(studentGuardians),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  tenant: one(organizations, { fields: [students.tenantId], references: [organizations.id] }),
  user: one(users, { fields: [students.userId], references: [users.id] }),
  admission: one(admissions, { fields: [students.admissionId], references: [admissions.id] }),
  primaryGuardian: one(guardians, { fields: [students.primaryGuardianId], references: [guardians.id] }),
  studentHouse: one(studentHouses, { fields: [students.studentHouseId], references: [studentHouses.id] }),
  studentGuardians: many(studentGuardians),
  documents: many(studentDocuments),
}));

export const studentGuardiansRelations = relations(studentGuardians, ({ one }) => ({
  student: one(students, { fields: [studentGuardians.studentId], references: [students.id] }),
  guardian: one(guardians, { fields: [studentGuardians.guardianId], references: [guardians.id] }),
  tenant: one(organizations, { fields: [studentGuardians.tenantId], references: [organizations.id] }),
}));

export const studentDocumentsRelations = relations(studentDocuments, ({ one }) => ({
  student: one(students, { fields: [studentDocuments.studentId], references: [students.id] }),
  tenant: one(organizations, { fields: [studentDocuments.tenantId], references: [organizations.id] }),
  verifiedByUser: one(users, { fields: [studentDocuments.verifiedBy], references: [users.id] }),
}));

export const admissionsRelations = relations(admissions, ({ one, many }) => ({
  tenant: one(organizations, { fields: [admissions.tenantId], references: [organizations.id] }),
  class: one(classes, { fields: [admissions.classId], references: [classes.id] }),
  assignedToStaff: one(staff, { fields: [admissions.assignedToStaffId], references: [staff.id] }),
  decidedByUser: one(users, { fields: [admissions.decidedBy], references: [users.id] }),
  student: one(students, { fields: [admissions.studentId], references: [students.id] }),
  statusHistory: many(admissionStatusHistory),
}));

export const admissionStatusHistoryRelations = relations(admissionStatusHistory, ({ one }) => ({
  tenant: one(organizations, { fields: [admissionStatusHistory.tenantId], references: [organizations.id] }),
  admission: one(admissions, { fields: [admissionStatusHistory.admissionId], references: [admissions.id] }),
  changedByUser: one(users, { fields: [admissionStatusHistory.changedBy], references: [users.id] }),
}));