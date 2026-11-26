import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../db';
import { academicYears } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { CreateAcademicYearInput, UpdateAcademicYearInput } from './academicYears.schemas';

// RULES (same as every module): every query has tenantId = tenant.id. A year id from another school is "not found".

const UNIQUE_VIOLATION = '23505';
// The name of the unique index that was broken, '' when it is unknown, null when this is not a unique violation.
function uniqueConstraint(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  // node-postgres errors sometimes arrive wrapped (DrizzleQueryError, .cause holds the real pg error)
  const pg = ((e as { cause?: unknown }).cause ?? e) as { code?: unknown; constraint?: unknown };
  const code = (e as { code?: unknown }).code ?? pg.code;
  if (code !== UNIQUE_VIOLATION) return null;
  return typeof pg.constraint === 'string' ? pg.constraint : '';
}

type YearRow = typeof academicYears.$inferSelect;
const HIDDEN = new Set<string>(['tenantId']);
const toYear = (y: YearRow) => Object.fromEntries(Object.entries(y).filter(([key]) => !HIDDEN.has(key)));

const NAME_TAKEN = 'That academic year name is already used in this school';

function conflictFor(e: unknown): HttpError | null {
  const constraint = uniqueConstraint(e);
  if (constraint === null) return null;
  if (constraint === 'academic_years_tenant_id_current_key') {
    return new HttpError(409, 'Another request made a different year current at the same time. Please try again');
  }
  return new HttpError(409, NAME_TAKEN);
}

export async function listAcademicYears(tenant: TenantContext): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(academicYears)
    .where(eq(academicYears.tenantId, tenant.id))
    .orderBy(desc(academicYears.startsOn), desc(academicYears.id));
  return rows.map(toYear);
}

export async function getCurrentAcademicYear(tenant: TenantContext): Promise<unknown> {
  const [row] = await db
    .select()
    .from(academicYears)
    .where(and(eq(academicYears.tenantId, tenant.id), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!row) throw new HttpError(404, 'No academic year is set up');
  return toYear(row);
}

export async function createAcademicYear(tenant: TenantContext, input: CreateAcademicYearInput): Promise<unknown> {
  try {
    const row = await db.transaction(async (tx) => {
      const [existingCurrent] = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, tenant.id), eq(academicYears.isCurrent, true)))
        .limit(1);
      const makeCurrent = input.isCurrent === true || !existingCurrent; // a school always has a current year
      if (makeCurrent && existingCurrent) {
        // clear first: the partial unique index allows only one current row per school at any moment
        await tx
          .update(academicYears)
          .set({ isCurrent: false })
          .where(and(eq(academicYears.tenantId, tenant.id), eq(academicYears.isCurrent, true)));
      }
      const [inserted] = await tx
        .insert(academicYears)
        .values({
          tenantId: tenant.id,
          name: input.name,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          isCurrent: makeCurrent,
        })
        .returning();
      return inserted;
    });
    return toYear(row);
  } catch (e) {
    throw conflictFor(e) ?? e;
  }
}

export async function updateAcademicYear(
  tenant: TenantContext,
  id: bigint,
  input: UpdateAcademicYearInput,
): Promise<unknown> {
  try {
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(academicYears)
        .where(and(eq(academicYears.id, id), eq(academicYears.tenantId, tenant.id)))
        .limit(1);
      if (!existing) throw new HttpError(404, 'Academic year not found');

      const startsOn = input.startsOn ?? existing.startsOn;
      const endsOn = input.endsOn ?? existing.endsOn;
      if (endsOn <= startsOn) {
        throw new HttpError(400, 'Validation failed', [{ field: 'endsOn', message: 'The year must end after it starts' }]);
      }

      if (input.isCurrent === true) {
        // clear every other current year of THIS school in the same transaction, then set this one
        await tx
          .update(academicYears)
          .set({ isCurrent: false })
          .where(and(eq(academicYears.tenantId, tenant.id), eq(academicYears.isCurrent, true), ne(academicYears.id, id)));
      }

      const [updated] = await tx
        .update(academicYears)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          startsOn,
          endsOn,
          ...(input.isCurrent === true ? { isCurrent: true } : {}),
        })
        .where(and(eq(academicYears.id, id), eq(academicYears.tenantId, tenant.id)))
        .returning();
      return updated;
    });
    return toYear(row);
  } catch (e) {
    throw conflictFor(e) ?? e;
  }
}

// THE one place that decides which academic year a request is about.
//   requested given -> that year, but only if it belongs to this school (otherwise 404, like any id from another school)
//   not given       -> the school's current year
//   no current year -> 409 "No academic year is set up"
export async function resolveAcademicYearId(tenant: TenantContext, requested?: bigint): Promise<bigint> {
  if (requested !== undefined) {
    const [row] = await db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.id, requested), eq(academicYears.tenantId, tenant.id)))
      .limit(1);
    if (!row) throw new HttpError(404, 'Academic year not found');
    return row.id;
  }
  const [current] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(and(eq(academicYears.tenantId, tenant.id), eq(academicYears.isCurrent, true)))
    .limit(1);
  if (!current) throw new HttpError(409, 'No academic year is set up');
  return current.id;
}
