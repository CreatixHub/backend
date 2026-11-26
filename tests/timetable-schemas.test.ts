import { describe, expect, it } from 'vitest';
import { createTimeSlotSchema, updateTimeSlotSchema } from '../src/modules/timetable/timetable.schemas';

// DB-free: the schemas are plain zod objects.
const slot = { name: 'Period 1', sequence: 1, startsAt: '09:00', endsAt: '09:40' };

describe('time slot dayType', () => {
  it('is trimmed and lower-cased on create, because publish keys its slots that way', () => {
    expect(createTimeSlotSchema.parse({ ...slot, dayType: ' Usual ' }).dayType).toBe('usual');
    expect(createTimeSlotSchema.parse({ ...slot, dayType: 'FRIDAY' }).dayType).toBe('friday');
  });

  it('is trimmed and lower-cased on update', () => {
    expect(updateTimeSlotSchema.parse({ dayType: ' Usual ' }).dayType).toBe('usual');
  });

  it('stays optional and keeps its length limits', () => {
    expect(createTimeSlotSchema.parse(slot).dayType).toBeUndefined();
    expect(createTimeSlotSchema.safeParse({ ...slot, dayType: '   ' }).success).toBe(false);
    expect(createTimeSlotSchema.safeParse({ ...slot, dayType: 'x'.repeat(41) }).success).toBe(false);
  });
});
