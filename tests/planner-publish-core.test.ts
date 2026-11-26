import { describe, expect, it } from 'vitest';
import type { Bell, ScheduleEntry } from '../src/modules/timetable-planner/engine/engine';
import {
  bellSlotDefs, countClassPeriods, describeConflicts, findConflicts, findProtectedSlotIssues, projectEntries, slotKey,
  teachingPeriodsByDay,
  type Booking, type SlotRecord, type SlotTarget, type SlotTime,
} from '../src/modules/timetable-planner/planner.publishCore';

// The pure rules of publishing: DB-free, so they always run.

const bell: Bell = {
  weekType: 'weekly',
  dayTypes: [
    {
      id: ' Usual ', name: 'School day', days: [1, 2, 3, 4],
      periods: [
        { id: 'p1', name: 'Period 1', startsAt: '09:00', endsAt: '09:40', isBreak: false },
        { id: 'br', name: 'Break', startsAt: '09:40', endsAt: '09:50', isBreak: true },
        { id: 'p2', name: 'Period 2', startsAt: '09:50', endsAt: '10:30', isBreak: false },
        { id: 'p3', name: 'Period 3', startsAt: '10:30', endsAt: '11:10', isBreak: false },
      ],
    },
    {
      id: 'friday', name: 'Friday', days: [5],
      periods: [{ id: 'f1', name: 'Period 1', startsAt: '09:00', endsAt: '09:30', isBreak: false }],
    },
  ],
};

const entry = (over: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: 'e1', blockId: 'b1', sectionId: '1', subjectId: '10', subjectName: 'Maths', teacherIds: ['7'], roomIds: [],
  day: 1, startNo: 1, length: 1, ...over,
});

// slot ids are "<dayType>-<sequence>"
const slotIdFor = (key: string) => key.replace('|', '-');
const periods = () => teachingPeriodsByDay(bell, slotIdFor);

describe('bellSlotDefs', () => {
  it('writes every period, breaks included, under a trimmed lowercase day type', () => {
    const defs = bellSlotDefs(bell);
    expect(defs.map((def) => [def.dayType, def.sequence, def.isBreak])).toEqual([
      ['usual', 1, false], ['usual', 2, true], ['usual', 3, false], ['usual', 4, false], ['friday', 1, false],
    ]);
    expect(defs[0]).toEqual(expect.objectContaining({ startsAt: '09:00:00', endsAt: '09:40:00', durationMinutes: 40, days: [1, 2, 3, 4] }));
  });

  it('refuses two day types that normalise to the same name', () => {
    const twin: Bell = { ...bell, dayTypes: [bell.dayTypes[0], { ...bell.dayTypes[0], id: 'USUAL' }] };
    expect(() => bellSlotDefs(twin)).toThrow(/both called "usual"/);
  });
});

describe('teachingPeriodsByDay', () => {
  it('numbers the teaching periods of each day and skips breaks', () => {
    const byDay = periods();
    expect(byDay.get(1)).toEqual([
      { slotId: 'usual-1', sequence: 1 }, { slotId: 'usual-3', sequence: 3 }, { slotId: 'usual-4', sequence: 4 },
    ]);
    expect(byDay.get(5)).toEqual([{ slotId: 'friday-1', sequence: 1 }]);
    expect(slotKey('usual', 3)).toBe('usual|3');
  });
});

describe('projectEntries', () => {
  it('expands a two-period block taught by two teachers into four rows', () => {
    const rows = projectEntries([entry({ teacherIds: ['7', '8'], roomIds: ['20', '21'], startNo: 2, length: 2 })], periods());
    expect(rows.map((row) => [row.slotId, row.teacherId])).toEqual([
      ['usual-3', '7'], ['usual-3', '8'], ['usual-4', '7'], ['usual-4', '8'],
    ]);
    expect(rows.every((row) => row.subjectId === '10' && row.title === null && row.day === 1)).toBe(true);
    expect(rows[0].roomIds).toEqual(['20', '21']);
    expect(countClassPeriods(rows)).toBe(2);
  });

  it('writes one teacherless row for an activity, titled with its name', () => {
    const [row, ...rest] = projectEntries(
      [entry({ subjectId: null, subjectName: 'Assembly', teacherIds: [], roomIds: ['30'] })], periods(),
    );
    expect(rest).toEqual([]);
    expect(row).toEqual(expect.objectContaining({ teacherId: null, subjectId: null, title: 'Assembly', roomIds: ['30'] }));
  });

  it('refuses a multi-period lesson whose periods are separated by a break', () => {
    // teaching periods 1 and 2 are bell periods 1 and 3, with the break between them
    expect(() => projectEntries([entry({ startNo: 1, length: 2 })], periods())).toThrow(/runs across a break/);
  });

  it('writes a row per class for a lesson combined across two classes, sharing the teacher and the period', () => {
    const rows = projectEntries([
      entry({ id: 'e1', blockId: 'b1', sectionId: '1', teacherIds: ['7'] }),
      entry({ id: 'e2', blockId: 'b1', sectionId: '2', teacherIds: ['7'] }),
    ], periods());
    expect(rows.map((row) => [row.sectionId, row.teacherId, row.slotId, row.day])).toEqual([
      ['1', '7', 'usual-1', 1], ['2', '7', 'usual-1', 1],
    ]);
    expect(countClassPeriods(rows)).toBe(2);
    // the new rows are not compared with each other: a combined lesson is not a clash
    const times = new Map<string, SlotTime>([['usual-1', { startsAt: '09:00:00', endsAt: '09:40:00' }]]);
    expect(findConflicts(rows, [], times)).toEqual([]);
  });

  it('refuses a lesson that points past the last period of its day', () => {
    expect(() => projectEntries([entry({ day: 5, startNo: 2 })], periods())).toThrow(/no longer matches the bell/);
    expect(() => projectEntries([entry({ day: 6 })], periods())).toThrow(/no longer matches the bell/);
  });
});

describe('findConflicts', () => {
  const times = new Map<string, SlotTime>([
    ['a', { startsAt: '09:00:00', endsAt: '09:40:00' }],
    ['b', { startsAt: '09:20:00', endsAt: '10:00:00' }],
    ['c', { startsAt: '09:40:00', endsAt: '10:20:00' }],
  ]);
  const booking = (over: Partial<Booking>): Booking => ({ sectionId: '1', day: 1, slotId: 'a', teacherId: '7', roomIds: [], ...over });
  const names = { teacher: (id: string) => `Teacher ${id}`, room: (id: string) => `Room ${id}`, section: (id: string) => `Class ${id}` };

  it('finds a teacher held by another class at an overlapping time', () => {
    const conflicts = findConflicts([booking({})], [booking({ sectionId: '2', slotId: 'b' })], times);
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'teacher', resourceId: '7', sectionId: '1', otherSectionId: '2' })]);
    expect(describeConflicts(conflicts, names)).toEqual([
      'Teacher 7 is already booked in Class 2 on Monday 09:00-09:40, which clashes with Class 1.',
    ]);
  });

  it('finds a room held only through classroomIds', () => {
    const conflicts = findConflicts(
      [booking({ teacherId: null, roomIds: ['20', '21'] })],
      [booking({ sectionId: '2', teacherId: '9', roomIds: ['21'] })], times,
    );
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'room', resourceId: '21' })]);
    expect(describeConflicts(conflicts, names)[0]).toContain('Room 21 is already booked in Class 2');
  });

  it('does not treat periods that only touch as overlapping', () => {
    expect(findConflicts([booking({})], [booking({ sectionId: '2', slotId: 'c' })], times)).toEqual([]);
  });

  it('does not treat different days as overlapping', () => {
    expect(findConflicts([booking({})], [booking({ sectionId: '2', day: 2 })], times)).toEqual([]);
  });

  it('lists every clash once, even when a team-taught period repeats the room', () => {
    const rows = [booking({ teacherId: '7', roomIds: ['20'] }), booking({ teacherId: '8', roomIds: ['20'] })];
    const kept = [booking({ sectionId: '2', teacherId: '7', roomIds: ['20'] }), booking({ sectionId: '3', teacherId: '8' })];
    const conflicts = findConflicts(rows, kept, times);
    expect(conflicts.map((conflict) => `${conflict.kind}:${conflict.resourceId}:${conflict.otherSectionId}`).sort()).toEqual([
      'room:20:2', 'teacher:7:2', 'teacher:8:3',
    ]);
  });

  it('reports a class that already has another lesson in the period', () => {
    const conflicts = findConflicts([booking({ teacherId: '7' })], [booking({ teacherId: '9' })], times);
    expect(describeConflicts(conflicts, names)).toEqual(['Class 1 already has another lesson on Monday 09:00-09:40.']);
  });

  it('ignores a row whose slot has no known time', () => {
    expect(findConflicts([booking({ slotId: 'unknown' })], [booking({ sectionId: '2' })], times)).toEqual([]);
  });
});

describe('findProtectedSlotIssues', () => {
  const slot = (over: Partial<SlotRecord>): SlotRecord => ({
    id: '1', dayType: 'usual', sequence: 1, name: 'Period 1', startsAt: '09:00:00', endsAt: '09:40:00', isBreak: false,
    days: [1, 2, 3, 4, 5, 6], ...over,
  });
  const target = (over: Partial<SlotTarget> = {}): SlotTarget => ({
    dayType: 'usual', sequence: 1, name: 'Period 1', startsAt: '09:00:00', endsAt: '09:40:00', isBreak: false,
    days: [1, 2, 3, 4, 5, 6], ...over,
  });
  const used = (...classes: string[]) => new Map([['1', classes]]);

  it('names the classes that use a period whose times would change', () => {
    expect(findProtectedSlotIssues([slot({ startsAt: '08:30:00', endsAt: '09:10:00' })], [target()], used('Grade 5 E', 'Grade 4 B'))).toEqual([
      'Slot Period 1 (usual #1) is used by Grade 4 B, Grade 5 E and would change from 08:30-09:10 to 09:00-09:40; move or clear those lessons first.',
    ]);
  });

  it('reports a change of weekdays or of break status', () => {
    const days = findProtectedSlotIssues([slot({})], [target({ days: [1, 2, 3, 4, 5] })], used('Grade 5 E'));
    expect(days[0]).toContain('would change from 09:00-09:40 on Mon, Tue, Wed, Thu, Fri, Sat to 09:00-09:40 on Mon, Tue, Wed, Thu, Fri;');
    expect(findProtectedSlotIssues([slot({})], [target({ isBreak: true })], used('Grade 5 E'))[0]).toContain('to 09:00-09:40 (break)');
  });

  it('leaves a period alone when nothing outside uses it, or nothing about it changes', () => {
    expect(findProtectedSlotIssues([slot({ startsAt: '08:30:00' })], [target()], new Map())).toEqual([]);
    expect(findProtectedSlotIssues([slot({})], [target()], used('Grade 5 E'))).toEqual([]);
    expect(findProtectedSlotIssues([slot({})], [target({ name: 'First lesson' })], used('Grade 5 E'))).toEqual([]);
  });

  it('refuses a used period missing from the new bell when it overlaps a new period on a shared weekday', () => {
    const old = slot({ dayType: 'saturday', sequence: 4, name: 'Saturday', startsAt: '09:20:00', endsAt: '10:00:00', days: [5, 6] });
    const issues = findProtectedSlotIssues([old], [target({ days: [1, 2, 3, 4, 5] })], used('Grade 5 E'));
    expect(issues).toEqual([
      'Slot Saturday (saturday #4) is used by Grade 5 E and would overlap Period 1 (usual #1, 09:00-09:40) on Fri; move or clear those lessons first.',
    ]);
    // no shared weekday, or only touching times: fine
    expect(findProtectedSlotIssues([{ ...old, days: [6] }], [target({ days: [1, 2, 3, 4, 5] })], used('Grade 5 E'))).toEqual([]);
    expect(findProtectedSlotIssues([{ ...old, startsAt: '09:40:00', endsAt: '10:20:00' }], [target({ days: [1, 2, 3, 4, 5] })], used('Grade 5 E'))).toEqual([]);
  });

  it('shortens a long list of classes', () => {
    const classes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => `Grade 5 ${name}`);
    expect(findProtectedSlotIssues([slot({ startsAt: '08:30:00' })], [target()], used(...classes))[0]).toContain('Grade 5 E and 2 more and would');
  });
});
