import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    phone: text("phone"),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("active"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    lastLoginAt: ts("last_login_at"),
    passwordChangedAt: ts("password_changed_at"),
    emailVerifiedAt: ts("email_verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
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

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  roles: many(roles),
  rolePermissions: many(rolePermissions),
  membershipRoles: many(membershipRoles),
  refreshTokens: many(refreshTokens),
  auditLogs: many(auditLog),
}));

export const usersRelations = relations(users, ({ many }) => ({
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