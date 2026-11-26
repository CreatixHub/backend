// Pure rules for bell time slots. No database and no app imports, so they can be unit-tested on their own.

export const DEFAULT_DAY_TYPE = 'usual';
export const DEFAULT_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6]; // Monday - Saturday (1 = Monday ... 7 = Sunday)

export interface SlotWindow {
  startsAt: string; // "HH:MM" or "HH:MM:SS"
  endsAt: string;
  days: readonly number[];
}

// "08:30" or "08:30:00" -> minutes since midnight
export const toMinutes = (t: string): number => {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
};

export const sharesADay = (a: readonly number[], b: readonly number[]): boolean => a.some((d) => b.includes(d));

// Two slots clash when they run on at least one common weekday AND their times overlap.
// Slots that only touch (one ends exactly when the next starts) do not clash.
export function slotsConflict(a: SlotWindow, b: SlotWindow): boolean {
  if (!sharesADay(a.days, b.days)) return false;
  return toMinutes(a.startsAt) < toMinutes(b.endsAt) && toMinutes(a.endsAt) > toMinutes(b.startsAt);
}
