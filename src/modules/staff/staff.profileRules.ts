import { HttpError } from '../../lib/errors';

// The parts of a teacher's teaching profile that need no database, so they can be unit tested on their own.
// (staff.profile.ts adds the database check that every subject belongs to this school.)

export const MAX_PERIODS_MESSAGE = 'Maximum periods per week must be a whole number from 1 to 35, or left blank.';

const isBlank = (value: unknown) => value === null || value === undefined || value === '';

// null / undefined / "" -> null (no limit). Otherwise a whole number from 1 to 35 (a numeric string like "30" is fine).
export function readMaxPeriods(raw: unknown): number | null {
  if (isBlank(raw)) return null;
  const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 35) throw new HttpError(400, MAX_PERIODS_MESSAGE);
  return value;
}

// A subject is either the primary one or an additional one, never both: drop the primary from the additional list
// (and any repeated subject).
export function withoutPrimary(additionalSubjectIds: bigint[], primarySubjectId: bigint | null): bigint[] {
  return [...new Set(additionalSubjectIds)].filter((id) => id !== primarySubjectId);
}
