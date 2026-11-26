import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { guardians, studentGuardians, students } from '../db/schema';
import { HttpError } from './errors';
import type { TenantContext } from './tenant';

const SCOPED_ROLES = new Set(['parent', 'student']);

export type StudentScope =
  | { scoped: false }
  | { scoped: true; studentIds: bigint[]; guardianIds: bigint[] };

/**
 * Returns true when ALL roles granting any of `requiredPerms` in this school are
 * row-scoped (`parent` or `student`). An owner (`*`) or staff role granting any of
 * those permissions gets full school-wide access.
 */
export function isRowScopedFor(tenant: TenantContext, ...requiredPerms: string[]): boolean {
  if (tenant.permissions.has('*')) return false;
  if (tenant.roles.length === 0) return false;

  if (!tenant.rolePermissions || tenant.rolePermissions.size === 0) {
    return tenant.roles.every((r) => SCOPED_ROLES.has(r));
  }

  const grantingRoles = tenant.roles.filter((role) => {
    const perms = tenant.rolePermissions!.get(role);
    if (!perms) return false;
    return requiredPerms.some((p) => perms.has(p));
  });

  if (grantingRoles.length === 0) {
    return tenant.roles.every((r) => SCOPED_ROLES.has(r));
  }

  return grantingRoles.every((role) => SCOPED_ROLES.has(role));
}

export async function resolveStudentScope(
  tenant: TenantContext,
  userId: bigint,
  ...requiredPerms: string[]
): Promise<StudentScope> {
  if (!isRowScopedFor(tenant, ...requiredPerms)) {
    return { scoped: false };
  }

  const [ownStudents, ownGuardians] = await Promise.all([
    db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.tenantId, tenant.id), eq(students.userId, userId), isNull(students.deletedAt))),
    db
      .select({ id: guardians.id })
      .from(guardians)
      .where(and(eq(guardians.tenantId, tenant.id), eq(guardians.userId, userId), isNull(guardians.deletedAt))),
  ]);

  const studentIdSet = new Set<bigint>(ownStudents.map((s) => s.id));
  const guardianIds = ownGuardians.map((g) => g.id);

  if (guardianIds.length > 0) {
    const linked = await db
      .select({ studentId: studentGuardians.studentId })
      .from(studentGuardians)
      .innerJoin(students, eq(studentGuardians.studentId, students.id))
      .where(
        and(
          eq(studentGuardians.tenantId, tenant.id),
          inArray(studentGuardians.guardianId, guardianIds),
          isNull(students.deletedAt),
        ),
      );
    for (const row of linked) studentIdSet.add(row.studentId);
  }

  return {
    scoped: true,
    studentIds: [...studentIdSet],
    guardianIds,
  };
}

/**
 * Helper for list endpoints: returns a SQL predicate restricting `column` to `scope.studentIds`,
 * or `null` if the scoped caller has zero linked students (caller should return empty list immediately).
 */
export function studentScopeCondition(column: PgColumn, scope: StudentScope): SQL | undefined | null {
  if (!scope.scoped) return undefined;
  if (scope.studentIds.length === 0) return null;
  return inArray(column, scope.studentIds);
}

/**
 * Throws 404 when reading/mutating a single resource by ID for an unlinked student,
 * avoiding existence leakage across students/parents.
 */
export function assertStudentReadable(scope: StudentScope, studentId: bigint | null | undefined, notFoundMsg: string): void {
  if (!scope.scoped) return;
  if (studentId == null || !scope.studentIds.includes(studentId)) {
    throw new HttpError(404, notFoundMsg);
  }
}

/**
 * Throws 403 before DB lookup when creating/submitting a record with an explicit unlinked studentId,
 * avoiding existence leakage across students.
 */
export function assertStudentWritable(scope: StudentScope, studentId: bigint | null | undefined): void {
  if (!scope.scoped) return;
  if (studentId == null || !scope.studentIds.includes(studentId)) {
    throw new HttpError(403, 'You can only perform this action for your linked student record');
  }
}
