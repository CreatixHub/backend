// The pure part of publishing a timetable: turning a version's lessons into one row per teacher per period,
// and finding double bookings. No database and no app imports, so it can be unit-tested on its own.
import { HttpError } from '../../lib/errors';
import { sharesADay, toMinutes } from '../timetable/slotOverlap';
import type { Bell, ScheduleEntry } from './engine/engine';
import { DAY_LABELS } from './planner.schemas';

/** One period of the bell as it is stored in `time_slots` (breaks included; `sequence` counts every period of the day type). */
export interface SlotDef {
  dayType: string;
  days: number[];
  sequence: number;
  name: string;
  startsAt: string;
  endsAt: string;
  isBreak: boolean;
  durationMinutes: number | null;
}

/** A row the publication will write to `timetable_entries` (ids are strings; the caller converts them). */
export interface ProjectedRow {
  blockId: string;
  sectionId: string;
  subjectId: string | null;
  teacherId: string | null;
  /** The activity name when the lesson has no subject; null for subject lessons. */
  title: string | null;
  slotId: string;
  day: number;
  roomIds: string[];
}

/** What a booking needs to be compared with another one. */
export interface Booking {
  sectionId: string;
  day: number;
  slotId: string;
  teacherId: string | null;
  roomIds: string[];
}

export interface SlotTime {
  startsAt: string;
  endsAt: string;
}

export type ConflictKind = 'teacher' | 'room' | 'section';

export interface Conflict {
  kind: ConflictKind;
  resourceId: string;
  day: number;
  /** The section the new timetable puts the resource in. */
  sectionId: string;
  /** The section that already holds the resource at an overlapping time. */
  otherSectionId: string;
  startsAt: string;
  endsAt: string;
}

export interface ConflictNames {
  teacher: (id: string) => string;
  room: (id: string) => string;
  section: (id: string) => string;
}

export const withSeconds = (time: string) => (time.length === 5 ? `${time}:00` : time);
export const slotKey = (dayType: string, sequence: number) => `${dayType}|${sequence}`;
/** The day type as it is stored in `time_slots`: trimmed and lowercase. */
export const normalizeDayType = (id: string) => id.trim().toLowerCase();

/** Every period of the bell (breaks included) as the time slot the publication needs. */
export function bellSlotDefs(bell: Bell): SlotDef[] {
  const seen = new Set<string>();
  return bell.dayTypes.flatMap((dayType) => {
    const key = normalizeDayType(dayType.id);
    if (!key) throw new HttpError(409, 'A day type in the bell has no name. Fix the bell and generate again.');
    if (seen.has(key)) throw new HttpError(409, `Two day types in the bell are both called "${key}". Rename one and generate again.`);
    seen.add(key);
    return dayType.periods.map((period, index) => ({
      dayType: key,
      days: [...dayType.days],
      sequence: index + 1,
      name: period.name,
      startsAt: withSeconds(period.startsAt),
      endsAt: withSeconds(period.endsAt),
      isBreak: period.isBreak,
      durationMinutes: toMinutes(period.endsAt) - toMinutes(period.startsAt),
    }));
  });
}

/** A teaching period of a weekday: its slot and its `sequence` in the day (breaks count, so a gap in sequence is a break). */
export interface TeachingPeriod {
  slotId: string;
  sequence: number;
}

/** The teaching (non-break) periods of each weekday, in order. Lesson `startNo` counts these. */
export function teachingPeriodsByDay(bell: Bell, slotIdFor: (key: string) => string): Map<number, TeachingPeriod[]> {
  const byDay = new Map<number, TeachingPeriod[]>();
  for (const dayType of bell.dayTypes) {
    const key = normalizeDayType(dayType.id);
    const teaching = dayType.periods.flatMap((period, index) =>
      (period.isBreak ? [] : [{ slotId: slotIdFor(slotKey(key, index + 1)), sequence: index + 1 }]));
    for (const day of dayType.days) byDay.set(day, teaching);
  }
  return byDay;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/**
 * Expand lessons into rows: one per period a lesson covers and per teacher (a team-taught lesson writes a row for each
 * teacher; an activity with no teacher writes one row with `teacherId: null` and the activity name as title).
 */
export function projectEntries(entries: ScheduleEntry[], periodsByDay: Map<number, TeachingPeriod[]>): ProjectedRow[] {
  const rows: ProjectedRow[] = [];
  for (const entry of entries) {
    let before: TeachingPeriod | undefined;
    for (let offset = 0; offset < entry.length; offset += 1) {
      const period = periodsByDay.get(entry.day)?.[entry.startNo + offset - 1];
      if (!period) throw new HttpError(409, 'A lesson no longer matches the bell schedule. Generate a fresh draft.');
      // a multi-period lesson is one run of periods: it cannot carry on across a break
      if (before && period.sequence !== before.sequence + 1) {
        throw new HttpError(409, `The ${entry.subjectName || 'a lesson'} lesson runs across a break in the bell schedule. Generate a fresh draft.`);
      }
      before = period;
      const slotId = period.slotId;
      for (const teacherId of entry.teacherIds.length ? entry.teacherIds : [null]) {
        rows.push({
          blockId: entry.blockId,
          sectionId: entry.sectionId,
          subjectId: entry.subjectId,
          teacherId,
          title: entry.subjectId ? null : entry.subjectName || null,
          slotId,
          day: entry.day,
          roomIds: [...entry.roomIds],
        });
      }
    }
  }
  return rows;
}

/** The class periods behind the rows: a team-taught period is one class period however many teachers it has. */
export const countClassPeriods = (rows: ProjectedRow[]) =>
  new Set(rows.map((row) => `${row.sectionId}:${row.day}:${row.slotId}`)).size;

/** Two periods overlap when each starts before the other ends. Periods that only touch do not overlap. */
export function timesOverlap(a: SlotTime, b: SlotTime): boolean {
  return toMinutes(a.startsAt) < toMinutes(b.endsAt) && toMinutes(b.startsAt) < toMinutes(a.endsAt);
}

/** Every resource (teacher, room, or the section itself) that a new row shares with a row that is kept, at overlapping times on the same day. */
export function findConflicts(newRows: Booking[], keptRows: Booking[], slotTimes: Map<string, SlotTime>): Conflict[] {
  const booked = new Map<string, Booking[]>();
  const add = (token: string, row: Booking) => {
    const rows = booked.get(token);
    if (rows) rows.push(row);
    else booked.set(token, [row]);
  };
  for (const row of keptRows) {
    add(`${row.day}|section|${row.sectionId}`, row);
    if (row.teacherId) add(`${row.day}|teacher|${row.teacherId}`, row);
    for (const roomId of unique(row.roomIds)) add(`${row.day}|room|${roomId}`, row);
  }

  const found = new Map<string, Conflict>();
  for (const row of newRows) {
    const time = slotTimes.get(row.slotId);
    if (!time) continue;
    const resources: [ConflictKind, string][] = [
      ['section', row.sectionId],
      ...(row.teacherId ? [['teacher', row.teacherId] as [ConflictKind, string]] : []),
      ...unique(row.roomIds).map((id): [ConflictKind, string] => ['room', id]),
    ];
    for (const [kind, resourceId] of resources) {
      for (const other of booked.get(`${row.day}|${kind}|${resourceId}`) ?? []) {
        const otherTime = slotTimes.get(other.slotId);
        if (!otherTime || !timesOverlap(time, otherTime)) continue;
        const conflict: Conflict = {
          kind, resourceId, day: row.day, sectionId: row.sectionId, otherSectionId: other.sectionId,
          startsAt: time.startsAt, endsAt: time.endsAt,
        };
        found.set([kind, resourceId, row.day, row.sectionId, other.sectionId, time.startsAt, time.endsAt].join('|'), conflict);
      }
    }
  }
  return [...found.values()];
}

const hhmm = (time: string) => time.slice(0, 5);

/** One readable sentence per conflict, naming the teacher or room and both classes. */
export function describeConflicts(conflicts: Conflict[], names: ConflictNames): string[] {
  return conflicts.map((conflict) => {
    const day = DAY_LABELS[conflict.day as keyof typeof DAY_LABELS] ?? `day ${conflict.day}`;
    const when = `${day} ${hhmm(conflict.startsAt)}-${hhmm(conflict.endsAt)}`;
    const section = names.section(conflict.sectionId);
    if (conflict.kind === 'section') return `${section} already has another lesson on ${when}.`;
    const resource = conflict.kind === 'teacher' ? names.teacher(conflict.resourceId) : names.room(conflict.resourceId);
    return `${resource} is already booked in ${names.section(conflict.otherSectionId)} on ${when}, which clashes with ${section}.`;
  });
}

// ------------------------------------------------------------------ periods other classes still use

/** A period (time slot) as it is stored. */
export interface SlotRecord {
  id: string;
  dayType: string;
  sequence: number;
  name: string;
  startsAt: string;
  endsAt: string;
  isBreak: boolean;
  days: number[];
}

/** A period definition a publication or a restore is about to write. */
export type SlotTarget = Pick<SlotRecord, 'dayType' | 'sequence' | 'name' | 'startsAt' | 'endsAt' | 'isBreak' | 'days'>;

const range = (slot: SlotTime) => `${hhmm(slot.startsAt)}-${hhmm(slot.endsAt)}`;
const dayNames = (days: number[]) =>
  [...days].sort((a, b) => a - b).map((day) => (DAY_LABELS[day as keyof typeof DAY_LABELS] ?? String(day)).slice(0, 3)).join(', ');
const sameDays = (a: number[], b: number[]) => dayNames(a) === dayNames(b);

function usersText(users: string[]) {
  const names = [...new Set(users)].sort();
  return names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
}

/**
 * Periods that lessons outside the publication (other classes, or any class of another academic year) still use must not
 * move under them. `usedOutside` maps a slot id to the names of those classes. A used period that the new definitions
 * would change (times, break or weekdays), or that the new definitions do not have but would overlap on a shared weekday,
 * is reported with the classes using it. An empty list means nothing outside is disturbed.
 */
export function findProtectedSlotIssues(existing: SlotRecord[], target: SlotTarget[], usedOutside: Map<string, string[]>): string[] {
  const targetByKey = new Map(target.map((slot) => [slotKey(slot.dayType, slot.sequence), slot]));
  const issues: string[] = [];
  for (const slot of existing) {
    const users = usedOutside.get(slot.id);
    if (!users?.length) continue;
    const label = `Slot ${slot.name} (${slot.dayType} #${slot.sequence}) is used by ${usersText(users)}`;
    const next = targetByKey.get(slotKey(slot.dayType, slot.sequence));
    if (next) {
      const daysChanged = !sameDays(slot.days, next.days);
      if (toMinutes(slot.startsAt) === toMinutes(next.startsAt) && toMinutes(slot.endsAt) === toMinutes(next.endsAt)
        && slot.isBreak === next.isBreak && !daysChanged) continue;
      const describe = (value: SlotTarget | SlotRecord) =>
        `${range(value)}${value.isBreak ? ' (break)' : ''}${daysChanged ? ` on ${dayNames(value.days)}` : ''}`;
      issues.push(`${label} and would change from ${describe(slot)} to ${describe(next)}; move or clear those lessons first.`);
    } else {
      const overlapped = target.find((other) => sharesADay(slot.days, other.days) && timesOverlap(slot, other));
      if (overlapped) {
        const shared = dayNames(slot.days.filter((day) => overlapped.days.includes(day)));
        issues.push(`${label} and would overlap ${overlapped.name} (${overlapped.dayType} #${overlapped.sequence}, ${range(overlapped)}) on ${shared}; move or clear those lessons first.`);
      }
    }
  }
  return issues;
}
