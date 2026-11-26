import { describe, expect, it } from 'vitest';
import { DEFAULT_DAYS, sharesADay, slotsConflict, toMinutes } from '../src/modules/timetable/slotOverlap';

// No database here: the pure rule behind "which bell slots may overlap" (see time-slots-day-types.test.ts for the API).

const MON_THU = [1, 2, 3, 4];
const FRIDAY = [5];

describe('slot overlap rule', () => {
  it('reads HH:MM and HH:MM:SS as minutes', () => {
    expect(toMinutes('09:40')).toBe(580);
    expect(toMinutes('09:40:00')).toBe(580);
  });

  it('slots that share a day and overlap in time clash', () => {
    expect(slotsConflict({ startsAt: '09:00', endsAt: '09:40', days: MON_THU }, { startsAt: '09:30', endsAt: '10:10', days: [4, 5] })).toBe(true);
    // one slot completely inside the other
    expect(slotsConflict({ startsAt: '09:00', endsAt: '10:00', days: DEFAULT_DAYS }, { startsAt: '09:10', endsAt: '09:20', days: [2] })).toBe(true);
  });

  it('slots on different days never clash, even at the same time', () => {
    expect(slotsConflict({ startsAt: '09:00', endsAt: '09:40', days: MON_THU }, { startsAt: '09:00', endsAt: '09:40', days: FRIDAY })).toBe(false);
    expect(sharesADay(MON_THU, FRIDAY)).toBe(false);
    expect(sharesADay([1, 5], FRIDAY)).toBe(true);
  });

  it('slots that only touch do not clash', () => {
    expect(slotsConflict({ startsAt: '09:00', endsAt: '09:40', days: DEFAULT_DAYS }, { startsAt: '09:40', endsAt: '10:20', days: DEFAULT_DAYS })).toBe(false);
  });

  it('is symmetric and compares HH:MM with HH:MM:SS', () => {
    const a = { startsAt: '09:00:00', endsAt: '09:40:00', days: [1] };
    const b = { startsAt: '09:39', endsAt: '10:00', days: [1] };
    expect(slotsConflict(a, b)).toBe(true);
    expect(slotsConflict(b, a)).toBe(true);
  });
});
