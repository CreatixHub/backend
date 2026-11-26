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
  staffSubjects,
  subjects,
  users,
} from '../../db/schema';
import { encryptField } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import { resolveAcademicYearId } from '../academic-years/academicYears.service';
import type { CreateStaffInput, ListStaffInput, UpdateStaffInput } from './staff.schemas';
import { saveAssignments } from './staff.assignments';
import { ensureClassSubjects, ensureDefaultSections } from './staff.assignAdmin';
import { parseTeachingProfile, type TeachingProfile } from './staff.profile';
import { withoutPrimary } from './staff.profileRules';

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

// ---- teaching profile: primary subject + max periods are columns on staff, the other subjects are staff_subjects rows ----
const TEACHING_ONLY = 'Only teaching staff can have a teaching profile (subjects and maximum periods per week).';

type Reader = Pick<typeof db, 'select'>;

// The additional subjects of the given staff members (by staff id), in a stable order.
async function loadAdditionalSubjects(
  tenantId: bigint,
  staffIds: bigint[],
  reader: Reader = db,
): Promise<Map<string, bigint[]>> {
  const byStaff = new Map<string, bigint[]>();
  if (staffIds.length === 0) return byStaff;
  const rows = await reader
    .select({ staffId: staffSubjects.staffId, subjectId: staffSubjects.subjectId })
    .from(staffSubjects)
    .where(and(eq(staffSubjects.tenantId, tenantId), inArray(staffSubjects.staffId, staffIds)))
    .orderBy(asc(staffSubjects.subjectId));
  for (const r of rows) byStaff.set(String(r.staffId), [...(byStaff.get(String(r.staffId)) ?? []), r.subjectId]);
  return byStaff;
}

const withProfile = (row: StaffRow, additional: Map<string, bigint[]>) => ({
  ...toStaff(row),
  additionalSubjectIds: additional.get(String(row.id)) ?? [],
});

const hasProfile = (p: TeachingProfile) =>
  p.primarySubjectId !== null || p.additionalSubjectIds.length > 0 || p.maxPeriodsPerWeek !== null;

// Only the keys the client really sent (a PATCH must not wipe fields it did not mention).
const onlySent = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

const joinName =(first: string | null | undefined, last: string | null | undefined) =>
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
// (the teaching profile fields are saved separately, so they are not part of this input)
function toColumns(
  input: Omit<UpdateStaffInput, 'primarySubjectId' | 'additionalSubjectIds' | 'maxPeriodsPerWeek'>,
): Partial<StaffInsert> {
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

  const additional = await loadAdditionalSubjects(tenant.id, ids);
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
        ...withProfile(r, additional),
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
  const row = await loadStaff(tenant.id, id);
  return withProfile(row, await loadAdditionalSubjects(tenant.id, [row.id]));
}

// The signed-in staff member's own record. No permission check: the lookup is tied to the caller's own login.
export async function getMyStaff(tenant: TenantContext, actor: AuthUser): Promise<unknown> {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.tenantId, tenant.id), eq(staff.userId, actor.id), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'No staff record is linked to this login');
  return withProfile(row, await loadAdditionalSubjects(tenant.id, [row.id]));
}

export async function createStaff(tenant: TenantContext, _actor: AuthUser, input: CreateStaffInput): Promise<unknown> {
  // assignments + academicYearId are saved to section_teachers, not to the staff table
  const {
    createLogin,
    roleCode: chosenRole,
    assignments,
    academicYearId: requestedYearId,
    primarySubjectId,
    additionalSubjectIds,
    maxPeriodsPerWeek,
    ...staffInput
  } = input;
  if (assignments?.length && requestedYearId === undefined) {
    throw new HttpError(400, 'academicYearId is required when assigning classes and subjects');
  }
  const academicYearId =
    requestedYearId === undefined ? undefined : await resolveAcademicYearId(tenant, requestedYearId);
  await assertRelations(tenant.id, staffInput.userId, staffInput.reportsToId);
  const columns = toColumns(staffInput);
  const profile = await parseTeachingProfile(
    onlySent({ primarySubjectId, additionalSubjectIds, maxPeriodsPerWeek }),
    tenant.id,
  );
  if (staffInput.staffType !== 'teaching' && hasProfile(profile)) throw new HttpError(400, TEACHING_ONLY);

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
          const NON_TEACHING_ROLES = ['staff', 'accountant', 'librarian', 'receptionist', 'warden', 'transport_manager', 'nurse', 'security'];
          if (chosenRole && !NON_TEACHING_ROLES.includes(chosenRole)) throw new HttpError(400, 'That login role is not allowed for staff');
          const roleCode = staffInput.staffType === 'teaching' ? 'teacher' : (chosenRole ?? 'staff');
          const [role] = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.tenantId, tenant.id), eq(roles.code, roleCode)))
            .limit(1);
          let roleId: bigint;
          if (role) roleId = role.id;
          else if (roleCode === 'staff') {
            const [made] = await tx
              .insert(roles)
              .values({ tenantId: tenant.id, code: 'staff', name: 'Staff', description: 'Non-teaching staff', isSystem: false })
              .returning({ id: roles.id });
            roleId = made.id;
          } else throw new HttpError(400, `The "${roleCode}" role is missing in this school`);

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
            roleId,
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
            primarySubjectId: profile.primarySubjectId,
            maxPeriodsPerWeek: profile.maxPeriodsPerWeek,
          })
          .returning();

        // the other subjects this teacher can teach (same transaction as the staff row)
        if (profile.additionalSubjectIds.length > 0) {
          await tx
            .insert(staffSubjects)
            .values(profile.additionalSubjectIds.map((subjectId) => ({ staffId: row.id, subjectId, tenantId: tenant.id })));
        }

        // the classes and subjects this teacher takes (all-or-nothing with the teacher and login)
        if (assignments?.length && academicYearId !== undefined) {
          // a class with no section gets a default section "A" first
          await ensureDefaultSections(
            tx,
            tenant.id,
            assignments.map((a) => a.classId),
          );
          // the timetable only accepts subjects registered for the class
          await ensureClassSubjects(tx, tenant.id, assignments);
          await saveAssignments(tx, tenant.id, row.id, academicYearId, assignments);
        }

        return { ...toStaff(row), additionalSubjectIds: profile.additionalSubjectIds, ...(login ? { login } : {}) };
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
  // the teaching profile is saved separately (staff_subjects rows), so it is taken out of the plain staff columns
  const { primarySubjectId, additionalSubjectIds, maxPeriodsPerWeek, ...rest } = input;
  const existing = await loadStaff(tenant.id, id);
  await assertRelations(tenant.id, rest.userId, rest.reportsToId, id);

  // leaving the school needs a leaving date (either sent now or already on file)
  const nextStatus = rest.status ?? existing.status;
  const nextLeftOn = rest.leftOn !== undefined ? rest.leftOn : existing.leftOn;
  if (nextStatus === 'left' && !nextLeftOn) {
    throw new HttpError(400, 'Validation failed', [{ field: 'leftOn', message: 'Required when status is left' }]);
  }

  const set = toColumns(rest);
  if (rest.firstName !== undefined || rest.lastName !== undefined) {
    set.fullName = joinName(
      rest.firstName ?? existing.firstName,
      rest.lastName !== undefined ? rest.lastName : existing.lastName,
    );
  }

  // Teaching profile: only the fields that were sent change, and the primary subject never stays in the additional list.
  const sent = onlySent({ primarySubjectId, additionalSubjectIds, maxPeriodsPerWeek });
  const profile = await parseTeachingProfile(sent, tenant.id);
  const nextType = rest.staffType ?? existing.staffType;
  if (nextType !== 'teaching' && hasProfile(profile)) throw new HttpError(400, TEACHING_ONLY);

  let nextAdditional: bigint[] | undefined; // undefined = leave the staff_subjects rows alone
  if (nextType !== 'teaching') {
    // switched away from teaching: the profile goes with it
    set.primarySubjectId = null;
    set.maxPeriodsPerWeek = null;
    nextAdditional = [];
  } else {
    if ('primarySubjectId' in sent) set.primarySubjectId = profile.primarySubjectId;
    if ('maxPeriodsPerWeek' in sent) set.maxPeriodsPerWeek = profile.maxPeriodsPerWeek;
    if ('primarySubjectId' in sent || 'additionalSubjectIds' in sent) {
      const primary = 'primarySubjectId' in sent ? profile.primarySubjectId : existing.primarySubjectId;
      const current =
        'additionalSubjectIds' in sent
          ? profile.additionalSubjectIds
          : ((await loadAdditionalSubjects(tenant.id, [id])).get(String(id)) ?? []);
      nextAdditional = withoutPrimary(current, primary);
    }
  }
  if (Object.keys(set).length === 0) set.updatedAt = new Date(); // only the subject list changed: still touch the row

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(staff)
        .set(set)
        .where(and(eq(staff.id, id), eq(staff.tenantId, tenant.id), isNull(staff.deletedAt)))
        .returning();

      if (nextAdditional !== undefined) {
        await tx.delete(staffSubjects).where(and(eq(staffSubjects.staffId, id), eq(staffSubjects.tenantId, tenant.id)));
        if (nextAdditional.length > 0) {
          await tx
            .insert(staffSubjects)
            .values(nextAdditional.map((subjectId) => ({ staffId: id, subjectId, tenantId: tenant.id })));
        }
      }
      return withProfile(row, await loadAdditionalSubjects(tenant.id, [id], tx));
    });
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