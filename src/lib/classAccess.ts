import { AsyncLocalStorage } from 'node:async_hooks';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { admissions } from '../db/schema';
import type { TenantContext } from './tenant';

export const classLimitStore = new AsyncLocalStorage<{ ids: bigint[] }>();

const rowsOf = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as any)?.rows ?? []));

let ready: Promise<unknown> | null = null;
export function ensureClassAccessTable(): Promise<unknown> {
  if (!ready) {
    ready = db
      .execute(
        sql`create table if not exists staff_class_access (
          id bigserial primary key,
          tenant_id bigint not null,
          staff_id bigint not null,
          class_id bigint not null,
          created_at timestamptz not null default now(),
          unique (tenant_id, staff_id, class_id)
        )`,
      )
      .catch((e) => {
        ready = null;
        throw e;
      });
  }
  return ready;
}

/** Only people holding the Admission Officer role (and not an admin) are limited to their ticked classes. */
export function isClassLimited(tenant: TenantContext): boolean {
  if (tenant.permissions.has('*')) return false;
  if (tenant.roles.includes('admin') || tenant.roles.includes('owner')) return false;
  return tenant.roles.includes('admission_officer');
}

export async function allowedClassIds(tenant: TenantContext, userId: bigint): Promise<bigint[]> {
  await ensureClassAccessTable();
  const r = await db.execute(
    sql`select a.class_id from staff_class_access a
        join staff s on s.id = a.staff_id
        where a.tenant_id = ${String(tenant.id)}::bigint and s.user_id = ${String(userId)}::bigint`,
  );
  return rowsOf(r).map((x) => BigInt(x.class_id));
}

/** SQL condition for list queries; undefined when the caller is not limited. */
export function admissionClassCondition(column: PgColumn) {
  const s = classLimitStore.getStore();
  if (!s) return undefined;
  if (s.ids.length === 0) return sql`false`;
  return inArray(column, s.ids);
}

/** Student scope for a limited officer: students who were admitted into the ticked classes. */
export async function officerStudentScope(tenant: TenantContext, userId: bigint) {
  if (!isClassLimited(tenant)) return null;
  const ids = await allowedClassIds(tenant, userId);
  if (ids.length === 0) return { scoped: true as const, studentIds: [] as bigint[], guardianIds: [] as bigint[] };
  const rows = await db
    .select({ studentId: admissions.studentId })
    .from(admissions)
    .where(and(eq2(admissions.tenantId, tenant.id), inArray(admissions.classId, ids), isNull(admissions.deletedAt)));
  const studentIds = [...new Set(rows.map((r) => r.studentId).filter((v): v is bigint => v != null))];
  return { scoped: true as const, studentIds, guardianIds: [] as bigint[] };
}

import { eq as eq2 } from 'drizzle-orm';