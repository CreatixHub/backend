import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors';
import { MAX_PERIODS_MESSAGE, readMaxPeriods, withoutPrimary } from '../src/modules/staff/staff.profileRules';

// No database here: these are the pure rules behind a teacher's teaching profile (see staff-profile.test.ts for the API).

describe('teaching profile rules', () => {
  it('uses the agreed message for a bad maximum', () => {
    expect(MAX_PERIODS_MESSAGE).toBe('Maximum periods per week must be a whole number from 1 to 35, or left blank.');
  });

  it('accepts 1 and 35 (also as text)', () => {
    expect(readMaxPeriods(1)).toBe(1);
    expect(readMaxPeriods(35)).toBe(35);
    expect(readMaxPeriods('30')).toBe(30);
  });

  it('rejects 0, 36, 2.5 and non-numbers with the message', () => {
    for (const bad of [0, 36, 2.5, -1, 'abc', '2.5', ' ', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      let thrown: unknown;
      try {
        readMaxPeriods(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, String(bad)).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(400);
      expect((thrown as HttpError).message).toBe(MAX_PERIODS_MESSAGE);
    }
  });

  it('blank clears the maximum', () => {
    expect(readMaxPeriods(null)).toBeNull();
    expect(readMaxPeriods(undefined)).toBeNull();
    expect(readMaxPeriods('')).toBeNull();
  });

  it('removes the primary subject (and repeats) from the additional list', () => {
    expect(withoutPrimary([1n, 2n, 2n, 3n], 1n)).toEqual([2n, 3n]);
    expect(withoutPrimary([1n, 2n], null)).toEqual([1n, 2n]);
    expect(withoutPrimary([], 5n)).toEqual([]);
  });
});
