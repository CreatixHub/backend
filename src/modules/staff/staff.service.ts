import * as argon2 from 'argon2';
import { and, asc, count, eq, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  classes,
  membershipRoles,
  memberships,
  roles,
  sectionTeachers,
  sections,
  staff,
  subjects,
  users,
} from '../../db/schema';
import { encryptField } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { CreateStaffInput, ListStaffInput, UpdateStaffInput } from './staff.schemas';
import { saveAssignments } from './staff.assignments';
import { ensureClassSubjects, ensureDefaultSections } from './staff.assignAdmin';

// RULES (same as members): every query has tenantId = tenant.id, and soft-deleted rows (deletedAt set) are invisible.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error) and
  // sometimes not, depending on the code path - check both rather than assuming one shape.
  const code = (e as { code?: unknown }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

type StaffRow = typeof staff.$inferSelect;
type StaffInsert = typeof staff.$inferInsert;

// Never sent to the client. The three *_enc columns hold encrypted values and are replaced by yes/no flags.
const HIDDEN = new Set<string>(['tenantId', 'deletedAt', 'deletedBy', 'nationalIdEnc', 'panEnc', 'bankAccountEnc']);

const toStaff = (s: StaffRow) => ({
  ...Object.fromEntries(Object.entries(s).filter(([key]) => !HIDDEN.has(key))),
  hasNationalId: s.nationalIdEnc !== null,
  hasPan: s.panEnc !== null,
  hasBankAccount: s.bankAccountEnc !== null,
});

const joinName = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

// DD-MM-YYYY (10 characters, so it passes the 10-character password rule)
const dobPassword = (dob: string) => {
  const [y, m, d] = dob.split('-');
  return `${d}-${m}-${y}`;
};

async function loadStaff(tenantId: bigint, id: bigint): Promise<StaffRow> {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Staff member not found');
  return row;
}

// The login account must belong to THIS school and be free; the manager must be staff of THIS school.
async function assertRelations(tenantId: bigint, userId?: bigint | null, reportsToId?: bigint | null, selfId?: bigint) {
  if (userId) {
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), eq(memberships.status, 'active')))
      .limit(1);
    if (!member) throw new HttpError(400, 'That user is not an active member of this school');

    const [linked] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.tenantId, tenantId),
          eq(staff.userId, userId),
          isNull(staff.deletedAt),
          selfId === undefined ? undefined : ne(staff.id, selfId),
        ),
      )
      .limit(1);
    if (linked) throw new HttpError(409, 'That user is already linked to another staff member');
  }

  if (reportsToId) {
    if (selfId !== undefined && reportsToId === selfId) {
      throw new HttpError(400, 'A staff member cannot report to themselves');
    }
    const [manager] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.id, reportsToId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
      .limit(1);
    if (!manager) throw new HttpError(400, 'Manager not found in this school');
  }
}

// API input -> database columns: the three sensitive values are encrypted, experience becomes numeric text.
function toColumns(input: UpdateStaffInput): Partial<StaffInsert> {
  const { nationalId, pan, bankAccountNumber, experienceYears, ...plain } = input;
  const columns: Partial<StaffInsert> = { ...plain };
  if (nationalId !== undefined) columns.nationalIdEnc = nationalId === null ? null : encryptField(nationalId);
  if (pan !== undefined) columns.panEnc = pan === null ? null : encryptField(pan);
  if (bankAccountNumber !== undefined) {
    columns.bankAccountEnc = bankAccountNumber === null ? null : encryptField(bankAccountNumber);
  }
  if (experienceYears !== undefined) {
    columns.experienceYears = experienceYears === null ? null : experienceYears.toFixed(1);
  }
  return columns;
}

// EMP-0001, EMP-0002 ... counted per school (deleted staff still count, so numbers are never reused).
async function nextEmployeeNo(tenantId: bigint, offset: number): Promise<string> {
  const [{ total }] = await db.select({ total: count() }).from(staff).where(eq(staff.tenantId, tenantId));
  return `EMP-${String(total + 1 + offset).padStart(4, '0')}`;
}

export async function listStaff(
  tenant: TenantContext,
  q: ListStaffInput,
): Promise<{ rows: unknown[]; meta: { page: number; limit: number; total: number; pages: number } }> {
  const where = and(
    eq(staff.tenantId, tenant.id),
    isNull(staff.deletedAt),
    q.staffType ? eq(staff.staffType, q.staffType) : undefined,
    q.status ? eq(staff.status, q.status) : undefined,
    q.employmentType ? eq(staff.employmentType, q.employmentType) : undefined,
    q.q
      ? or(ilike(staff.fullName, `%${q.q}%`), ilike(staff.employeeNo, `%${q.q}%`), ilike(staff.email, `%${q.q}%`))
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(where)
      .orderBy(asc(staff.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(staff).where(where),
  ]);

  // What each teacher on this page really teaches (from section_teachers).
  const ids = rows.map((r) => r.id);
  const mapped =
    ids.length === 0
      ? []
      : await db
          .select({
            teacherId: sectionTeachers.teacherId,
            className: classes.name,
            sectionName: sections.name,
            subjectName: subjects.name,
          })
          .from(sectionTeachers)
          .innerJoin(sections, eq(sections.id, sectionTeachers.sectionId))
          .innerJoin(classes, eq(classes.id, sections.classId))
          .innerJoin(subjects, eq(subjects.id, sectionTeachers.subjectId))
          .where(and(eq(sectionTeachers.tenantId, tenant.id), inArray(sectionTeachers.teacherId, ids)));

  const teaching = new Map<string, { classes: Set<string>; sections: Set<string>; subjects: Set<string> }>();
  for (const m of mapped) {
    const key = String(m.teacherId);
    const entry = teaching.get(key) ?? {
      classes: new Set<string>(),
      sections: new Set<string>(),
      subjects: new Set<string>(),
    };
    entry.classes.add(m.className);
    entry.sections.add(`${m.className} - ${m.sectionName}`);
    entry.subjects.add(m.subjectName);
    teaching.set(key, entry);
  }

  return {
    rows: rows.map((r) => {
      const t = teaching.get(String(r.id));
      return {
        ...toStaff(r),
        teaching: {
          classes: t ? [...t.classes] : [],
          sections: t ? [...t.sections] : [],
          subjects: t ? [...t.subjects] : [],
        },
      };
    }),
    meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
  };
}

export async function getStaff(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toStaff(await loadStaff(tenant.id, id));
}

// The signed-in staff member's own record. No permission check: the lookup is tied to the caller's own login.
export async function getMyStaff(tenant: TenantContext, actor: AuthUser): Promise<unknown> {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.userId, actor.id), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'No staff record is linked to this login');
  return toStaff(row);
}

export async function createStaff(tenant: TenantContext, _actor: AuthUser, input: CreateStaffInput): Promise<unknown> {
  // assignments + academicYearId are saved to section_teachers, not to the staff table
  const { createLogin, assignments, academicYearId, ...staffInput } = input;
  if (assignments && assignments.length > 0 && !academicYearId) {
    throw new HttpError(400, 'academicYearId is required when assigning classes and subjects');
  }
  await assertRelations(tenant.id, staffInput.userId, staffInput.reportsToId);
  const columns = toColumns(staffInput);

  // A login is made for teaching staff by default (unless an existing login is being linked or it is switched off).
  const wantsLogin = !staffInput.userId && (createLogin ?? staffInput.staffType === 'teaching');
  if (wantsLogin && !staffInput.dob) {
    throw new HttpError(400, 'Validation failed', [
      { field: 'dob', message: 'Date of birth is required to create a login (it is the first password)' },
    ]);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const employeeNo = staffInput.employeeNo ?? (await nextEmployeeNo(tenant.id, attempt));
    try {
      return await db.transaction(async (tx) => {
        let loginUserId: bigint | null = null;
        let login: { username: string; password: string } | null = null;

        if (wantsLogin) {
          const roleCode = staffInput.staffType === 'teaching' ? 'teacher' : 'staff';
          const [role] = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.tenantId, tenant.id), eq(roles.code, roleCode)))
            .limit(1);
          if (!role) throw new HttpError(400, `The "${roleCode}" role is missing in this school`);

          // username = phone; falls back to the employee number if empty or already taken
          const wantedPhone = staffInput.phone?.trim() || null;
          const wantedEmail = staffInput.email?.trim() || null;
          const [phoneAsUsername] = wantedPhone
            ? await tx.select({ id: users.id }).from(users).where(eq(users.username, wantedPhone)).limit(1)
            : [];
          const username = wantedPhone && !phoneAsUsername ? wantedPhone : employeeNo;

          // store phone/email on the login only when no other user already has them
          const [phoneTaken] = wantedPhone
            ? await tx.select({ id: users.id }).from(users).where(eq(users.phone, wantedPhone)).limit(1)
            : [];
          const [emailTaken] = wantedEmail
            ? await tx.select({ id: users.id }).from(users).where(eq(users.email, wantedEmail)).limit(1)
            : [];

          const [user] = await tx
            .insert(users)
            .values({
              username,
              phone: phoneTaken ? null : wantedPhone,
              email: emailTaken ? null : wantedEmail,
              fullName: joinName(staffInput.firstName, staffInput.lastName),
              passwordHash: await argon2.hash(dobPassword(staffInput.dob!)),
              userType: 'staff',
              mustChangePassword: true,
            })
            .returning({ id: users.id });

          const [membership] = await tx
            .insert(memberships)
            .values({ tenantId: tenant.id, userId: user.id })
            .returning({ id: memberships.id });

          await tx.insert(membershipRoles).values({
            membershipId: membership.id,
            roleId: role.id,
            tenantId: tenant.id,
          });

          loginUserId = user.id;
          login = { username, password: 'Date of birth (DD-MM-YYYY)' };
        }

        const [row] = await tx
          .insert(staff)
          .values({
            ...columns,
            tenantId: tenant.id,
            employeeNo,
            userId: loginUserId ?? staffInput.userId ?? null,
            fullName: joinName(staffInput.firstName, staffInput.lastName),
            staffType: staffInput.staffType,
            employmentType: staffInput.employmentType,
            joinedOn: staffInput.joinedOn,
          })
          .returning();

        // the classes and subjects this teacher takes (all-or-nothing with the teacher and login)
        if (assignments && assignments.length > 0) {
          // a class with no section gets a default section "A" first
          await ensureDefaultSections(
            tx,
            tenant.id,
            assignments.map((a) => a.classId),
          );
          // the timetable only accepts subjects registered for the class
          await ensureClassSubjects(tx, tenant.id, assignments);
          await saveAssignments(tx, tenant.id, row.id, academicYearId!, assignments);
        }

        return { ...toStaff(row), ...(login ? { login } : {}) };
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (staffInput.employeeNo) throw new HttpError(409, 'That employee number is already used in this school');
      // a generated number collided with another request at the same moment: try the next one
    }
  }
  throw new HttpError(409, 'Could not generate an employee number, please try again');
}

export async function updateStaff(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateStaffInput,
): Promise<unknown> {
  const existing = await loadStaff(tenant.id, id);
  await assertRelations(tenant.id, input.userId, input.reportsToId, id);

  // leaving the school needs a leaving date (either sent now or already on file)
  const nextStatus = input.status ?? existing.status;
  const nextLeftOn = input.leftOn !== undefined ? input.leftOn : existing.leftOn;
  if (nextStatus === 'left' && !nextLeftOn) {
    throw new HttpError(400, 'Validation failed', [{ field: 'leftOn', message: 'Required when status is left' }]);
  }

  const set = toColumns(input);
  if (input.firstName !== undefined || input.lastName !== undefined) {
    set.fullName = joinName(
      input.firstName ?? existing.firstName,
      input.lastName !== undefined ? input.lastName : existing.lastName,
    );
  }

  try {
    const [row] = await db
      .update(staff)
      .set(set)
      .where(and(eq(staff.id, id), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
      .returning();
    return toStaff(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'That employee number is already used in this school');
    throw e;
  }
}

// Soft delete: the row stays (history, payroll later); it just disappears from every list and lookup.
export async function removeStaff(tenant: TenantContext, actor: AuthUser, id: bigint): Promise<void> {
  await loadStaff(tenant.id, id);
  await db
    .update(staff)
    .set({ deletedAt: new Date(), deletedBy: actor.id })
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenant.id)));
}