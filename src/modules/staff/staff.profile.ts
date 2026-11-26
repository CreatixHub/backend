import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { subjects } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { readMaxPeriods, withoutPrimary } from './staff.profileRules';

// A teacher's teaching profile: the main subject, the other subjects they can teach, and the most periods a week.

export type TeachingProfile = {
  primarySubjectId: bigint | null;
  additionalSubjectIds: bigint[];
  maxPeriodsPerWeek: number | null;
};

const isBlank = (value: unknown) => value === null || value === undefined || value === '';

function toId(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) return BigInt(value);
  return null;
}

// Checks the profile fields in `input` (any key may be missing: missing means blank) and returns them cleaned up.
// Every subject must belong to THIS school, and the primary subject is removed from the additional list.
export async function parseTeachingProfile(input: unknown, tenantId: bigint): Promise<TeachingProfile> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const maxPeriodsPerWeek = readMaxPeriods(raw.maxPeriodsPerWeek);

  let primarySubjectId: bigint | null = null;
  if (!isBlank(raw.primarySubjectId)) {
    primarySubjectId = toId(raw.primarySubjectId);
    if (primarySubjectId === null) throw new HttpError(400, 'That primary subject no longer exists.');
  }

  const rawList = raw.additionalSubjectIds ?? [];
  if (!Array.isArray(rawList)) throw new HttpError(400, 'One of the additional subjects no longer exists.');
  const additional: bigint[] = [];
  for (const item of rawList) {
    const id = toId(item);
    if (id === null) throw new HttpError(400, 'One of the additional subjects no longer exists.');
    additional.push(id);
  }

  const wanted = [...new Set([...(primarySubjectId === null ? [] : [primarySubjectId]), ...additional])];
  if (wanted.length > 0) {
    const found = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.tenantId, tenantId), isNull(subjects.deletedAt), inArray(subjects.id, wanted)));
    const known = new Set(found.map((s) => s.id));
    if (primarySubjectId !== null && !known.has(primarySubjectId)) {
      throw new HttpError(400, 'That primary subject no longer exists.');
    }
    if (additional.some((id) => !known.has(id))) {
      throw new HttpError(400, 'One of the additional subjects no longer exists.');
    }
  }

  return { primarySubjectId, additionalSubjectIds: withoutPrimary(additional, primarySubjectId), maxPeriodsPerWeek };
}
