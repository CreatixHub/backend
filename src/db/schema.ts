import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
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

// ---------------------------------------------------------------- relations (for the `db.query.*` API)

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
