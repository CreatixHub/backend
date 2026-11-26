import { describe, expect, it } from 'vitest';
import { todayInTimezone } from '../src/lib/dates';

// No database here: today's date in a school's timezone.

const NOW = new Date('2026-11-24T20:00:00Z');

describe('todayInTimezone', () => {
  it('Asia/Kolkata is already on the next day at 20:00 UTC', () => {
    expect(todayInTimezone('Asia/Kolkata', NOW)).toBe('2026-11-25');
  });

  it('UTC stays on the same day', () => {
    expect(todayInTimezone('UTC', NOW)).toBe('2026-11-24');
  });

  it('a timezone behind UTC can be on the previous day', () => {
    expect(todayInTimezone('America/Los_Angeles', new Date('2026-11-24T05:00:00Z'))).toBe('2026-11-23');
  });

  it('an invalid timezone name falls back to UTC instead of throwing', () => {
    expect(todayInTimezone('Not/AZone', NOW)).toBe('2026-11-24');
    expect(todayInTimezone('', NOW)).toBe('2026-11-24');
  });
});
