import { describe, expect, it } from 'vitest';
import {
  CRITICAL,
  Schedule,
  analyze,
  generate,
  teacherLoads,
  type Bell,
  type BellPeriod,
  type Lesson,
  type LessonPart,
  type Problem,
  type RuleLevel,
  type RuleSet,
  type ScheduleEntry,
} from '../src/modules/timetable-planner/engine/engine';
import { generateInWorker } from '../src/modules/timetable-planner/engine/run-generate';

const period = (n: number, start: string, end: string): BellPeriod => ({ id: `p${n}`, name: `Period ${n}`, startsAt: start, endsAt: end, isBreak: false });
const brk = (id: string, start: string, end: string): BellPeriod => ({ id, name: 'Break', startsAt: start, endsAt: end, isBreak: true });

function bell(days = [1, 2, 3, 4, 5]): Bell {
  return {
    weekType: 'weekly',
    dayTypes: [
      {
        id: 'usual',
        name: 'Usual day',
        days,
        periods: [
          period(1, '08:00', '08:45'),
          period(2, '08:45', '09:30'),
          brk('b1', '09:30', '09:45'),
          period(3, '09:45', '10:30'),
          period(4, '10:30', '11:15'),
          period(5, '11:15', '12:00'),
          brk('lunch', '12:00', '12:40'),
          period(6, '12:40', '13:25'),
          period(7, '13:25', '14:10'),
        ],
      },
    ],
  };
}

const part = (id: string, teacherIds: string[], pattern: LessonPart['pattern'], extra: Partial<LessonPart> = {}): LessonPart => ({ id, label: '', teacherIds, mode: 'together', pattern, room: { type: 'none' }, ...extra });
const lesson = (id: string, sectionIds: string[], subjectName: string, parts: LessonPart[], extra: Partial<Lesson> = {}): Lesson => ({ id, sectionIds, subjectId: `sub-${subjectName}`, subjectName, parts, ...extra });

function school(overrides: Partial<Problem> = {}): Problem {
  return {
    days: [1, 2, 3, 4, 5],
    bell: bell(),
    sections: [
      { id: 's6a', name: '6A', className: 'Grade 6', capacity: 30 },
      { id: 's6b', name: '6B', className: 'Grade 6', capacity: 30 },
    ],
    staff: [
      { id: 't1', name: 'Anjali' },
      { id: 't2', name: 'Ben' },
      { id: 't3', name: 'Chen' },
      { id: 't4', name: 'Dina' },
    ],
    rooms: [
      { id: 'lab1', name: 'Lab 1', groupId: 'labs', capacity: 30 },
      { id: 'lab2', name: 'Lab 2', groupId: 'labs', capacity: 30 },
    ],
    availability: {},
    rules: {},
    lessons: [
      lesson('math', ['s6a', 's6b'].slice(0, 1), 'Maths', [part('main', ['t1'], [{ count: 4, length: 1 }, { count: 1, length: 2 }])]),
      lesson('math-b', ['s6b'], 'Maths', [part('main', ['t1'], [{ count: 4, length: 1 }, { count: 1, length: 2 }])]),
      lesson('eng', ['s6a'], 'English', [part('main', ['t2'], [{ count: 5, length: 1 }])]),
      lesson('eng-b', ['s6b'], 'English', [part('main', ['t2'], [{ count: 5, length: 1 }])]),
      lesson('sci', ['s6a'], 'Science', [
        part('theory', ['t3'], [{ count: 3, length: 1 }]),
        part('lab', ['t3'], [{ count: 1, length: 2 }], { room: { type: 'oneOf', groupId: 'labs' } }),
      ]),
      lesson('sci-b', ['s6b'], 'Science', [
        part('theory', ['t3'], [{ count: 3, length: 1 }]),
        part('lab', ['t3'], [{ count: 1, length: 2 }], { room: { type: 'oneOf', groupId: 'labs' } }),
      ]),
    ],
    ...overrides,
  };
}

/** The timetable's one hard promise: nobody is in two places at once. */
function assertNoClashes(entries: ScheduleEntry[], label = '') {
  const seen = { teacher: new Map<string, string>(), section: new Map<string, string>(), room: new Map<string, string>() };
  const claim = (kind: keyof typeof seen, id: string, e: ScheduleEntry, no: number) => {
    const key = `${id}|${e.day}|${no}`;
    const prior = seen[kind].get(key);
    if (prior && prior !== e.blockId) expect.fail(`${label}${kind} ${id} double-booked on day ${e.day} period ${no}`);
    seen[kind].set(key, e.blockId);
  };
  for (const e of entries) {
    for (let k = 0; k < e.length; k += 1) {
      const no = e.startNo + k;
      claim('section', e.sectionId, e, no);
      for (const t of e.teacherIds) claim('teacher', t, e, no);
      for (const r of e.roomIds) claim('room', r, e, no);
    }
  }
}

it('places every lesson with no clashes and respects the weekly pattern', () => {
  const result = generate(school(), { seed: 7, budgetMs: 300 });
  expect(result.unplaced.length, JSON.stringify(result.unplaced)).toBe(0);
  expect(result.stats.placedPeriods).toBe(result.stats.totalPeriods);
  assertNoClashes(result.entries);
  const maths6a = result.entries.filter((e) => e.sectionId === 's6a' && e.subjectName === 'Maths');
  expect(maths6a.reduce((n, e) => n + e.length, 0)).toBe(6);
  expect(maths6a.filter((e) => e.length === 2).length).toBe(1);
});

it('a double period never runs across a break', () => {
  const result = generate(school(), { seed: 3, budgetMs: 300 });
  const doubles = result.entries.filter((e) => e.length === 2);
  expect(doubles.length).toBeGreaterThanOrEqual(3);
  for (const e of doubles) {
    expect(e.startNo, 'periods 2 and 3 are separated by the morning break').not.toBe(2);
    expect(e.startNo, 'periods 5 and 6 are separated by lunch').not.toBe(5);
    expect(e.startNo + 1).toBeLessThanOrEqual(7);
  }
});

it('the same seed gives the same timetable', () => {
  // The iteration cap ends both runs, not the clock: a busy machine must not change how far each one gets.
  const a = generate(school(), { seed: 11, budgetMs: 600_000, maxIterations: 500 });
  const b = generate(school(), { seed: 11, budgetMs: 600_000, maxIterations: 500 });
  expect(a.entries.map((e) => [e.id, e.day, e.startNo])).toEqual(b.entries.map((e) => [e.id, e.day, e.startNo]));
});

it('staff availability is respected', () => {
  const problem = school({
    availability: { staff: { t1: [1, 2, 3, 4, 5].flatMap((day) => [1, 2, 3, 4].map((p) => ({ day, period: p }))) } },
  });
  const result = generate(problem, { seed: 5, budgetMs: 200 });
  assertNoClashes(result.entries);
  for (const e of result.entries.filter((x) => x.teacherIds.includes('t1'))) {
    expect(e.startNo, `Anjali is only free from period 5, got ${e.startNo}`).toBeGreaterThanOrEqual(5);
  }
});

it('team teaching books every teacher in the same period', () => {
  const problem = school({
    lessons: [lesson('team', ['s6a'], 'Science', [part('main', ['t1', 't2'], [{ count: 3, length: 1 }], { mode: 'together' })])],
  });
  const result = generate(problem, { seed: 2, budgetMs: 100 });
  expect(result.unplaced.length).toBe(0);
  for (const e of result.entries) expect([...e.teacherIds].sort()).toEqual(['t1', 't2']);
  assertNoClashes(result.entries);
});

it('"one of" teachers share the periods and stay balanced', () => {
  const problem = school({
    lessons: [lesson('shared', ['s6a'], 'Maths', [part('main', ['t1', 't2'], [{ count: 6, length: 1 }], { mode: 'one_of' })])],
  });
  const result = generate(problem, { seed: 4, budgetMs: 100 });
  expect(result.unplaced.length).toBe(0);
  const by: Record<string, number> = { t1: 0, t2: 0 };
  for (const e of result.entries) { expect(e.teacherIds.length).toBe(1); by[e.teacherIds[0]] += 1; }
  expect(Math.abs(by.t1 - by.t2), `unbalanced: ${JSON.stringify(by)}`).toBeLessThanOrEqual(2);
});

it('lessons in a same-time group start together, each with its own teacher and room', () => {
  const problem = school({
    lessons: [
      lesson('french', ['s6a'], 'French', [part('main', ['t1'], [{ count: 3, length: 1 }], { room: { type: 'fixed', roomIds: ['lab1'] } })], { syncGroup: 'second-language' }),
      lesson('hindi', ['s6a'], 'Hindi', [part('main', ['t2'], [{ count: 3, length: 1 }], { room: { type: 'fixed', roomIds: ['lab2'] } })], { syncGroup: 'second-language' }),
    ],
  });
  const result = generate(problem, { seed: 9, budgetMs: 100 });
  expect(result.unplaced.length).toBe(0);
  const french = result.entries.filter((e) => e.subjectName === 'French').map((e) => `${e.day}:${e.startNo}`).sort();
  const hindi = result.entries.filter((e) => e.subjectName === 'Hindi').map((e) => `${e.day}:${e.startNo}`).sort();
  expect(french).toEqual(hindi);
});

it('a combined lesson puts several classes in one slot', () => {
  const problem = school({
    lessons: [lesson('pe', ['s6a', 's6b'], 'PE', [part('main', ['t4'], [{ count: 2, length: 1 }])])],
  });
  const result = generate(problem, { seed: 1, budgetMs: 100 });
  expect(result.unplaced.length).toBe(0);
  const slots = result.entries.map((e) => `${e.day}:${e.startNo}`);
  expect(new Set(slots).size).toBe(2);
  expect(result.entries.length).toBe(4);
});

it('a lesson that cannot fit is reported with a named reason, not dropped silently', () => {
  // One teacher, one day, three periods... but eight periods of work.
  const problem = school({
    bell: { weekType: 'weekly', dayTypes: [{ id: 'one', name: 'One day', days: [1], periods: [period(1, '08:00', '08:45'), period(2, '08:45', '09:30'), period(3, '09:30', '10:15')] }] },
    days: [1],
    lessons: [
      lesson('a', ['s6a'], 'Maths', [part('main', ['t1'], [{ count: 2, length: 1 }])]),
      lesson('b', ['s6b'], 'Maths', [part('main', ['t1'], [{ count: 2, length: 1 }])]),
    ],
    rules: { defaults: { subjectSpread: { value: 5, level: 'off' } } },
  });
  const pre = analyze(problem);
  expect(pre.ok).toBe(false);
  expect(pre.blocking[0].message).toMatch(/Anjali/);
  const result = generate(problem, { seed: 1, budgetMs: 100 });
  expect(result.unplaced.length).toBe(1);
  expect(result.unplaced[0].reasons.join(' ')).toMatch(/Anjali/);
  assertNoClashes(result.entries);
});

it('locked lessons stay put when the timetable is regenerated', () => {
  const first = generate(school(), { seed: 1, budgetMs: 100 });
  const target = first.entries.find((e) => e.subjectName === 'English' && e.sectionId === 's6a')!;
  const locked = first.entries.map((e) => ({ ...e, locked: e.blockId === target.blockId }));
  const second = generate(school(), { seed: 99, budgetMs: 100, lockedEntries: locked });
  const kept = second.entries.find((e) => e.blockId === target.blockId)!;
  expect(kept.day).toBe(target.day);
  expect(kept.startNo).toBe(target.startNo);
  expect(kept.locked).toBe(true);
  assertNoClashes(second.entries);
});

it('the editor check names the clash, and a valid move is applied', () => {
  const { schedule } = generate(school(), { seed: 1, budgetMs: 100 });
  const entries = schedule.entries();
  const a = entries.find((e) => e.subjectName === 'English' && e.sectionId === 's6a');
  // Put 6A's English where 6B's English already is: Ben cannot teach both.
  const other = entries.find((e) => e.subjectName === 'English' && e.sectionId === 's6b');
  const clash = schedule.checkMove(a.blockId, other.day, other.startNo);
  expect(clash.ok).toBe(false);
  expect(clash.blockers.map((b) => b.message).join(' ')).toMatch(/Ben/);

  const map = schedule.fitMap(a.blockId);
  const free = map.find((m) => m.ok && !(m.day === a.day && m.first === a.startNo));
  if (free) {
    const moved = schedule.move(a.blockId, free.day, free.first);
    expect(moved.ok).toBe(true);
    assertNoClashes(schedule.entries());
  }
  // Nothing moved on a failed check.
  expect(schedule.entries().length).toBe(entries.length);
});

it('locked lessons cannot be moved or unscheduled', () => {
  const { schedule } = generate(school(), { seed: 1, budgetMs: 50 });
  const e = schedule.entries()[0];
  schedule.setLocked(e.blockId, true);
  expect(schedule.unschedule(e.blockId)).toBe(false);
  expect(schedule.checkMove(e.blockId, 5, 7).ok).toBe(false);
});

it('a schedule rebuilt from stored entries matches the original', () => {
  const { schedule, entries } = generate(school(), { seed: 21, budgetMs: 100 });
  const rebuilt = Schedule.fromEntries(school(), entries);
  expect(rebuilt.dropped.length).toBe(0);
  expect(rebuilt.entries().length).toBe(entries.length);
  expect(rebuilt.totalPenalty()).toBe(schedule.totalPenalty());
});

it('a classroom is never given two lessons at once, even when rooms are scarce', () => {
  const problem = school({
    rooms: [{ id: 'lab1', name: 'Lab 1', groupId: 'labs', capacity: 30 }],
  });
  const result = generate(problem, { seed: 8, budgetMs: 200 });
  assertNoClashes(result.entries);
  expect(result.unplaced.length).toBe(0);
});

it('insights flag a subject that bunches up on one day', () => {
  const { schedule } = generate(school(), { seed: 1, budgetMs: 100 });
  const insights = schedule.insights();
  expect(insights.total).toBe(insights.perfect + insights.poor);
  expect(insights.rows.every((r) => r.actual.length === 5)).toBe(true);
});

it('readiness catches a teacher who has more periods than free slots', () => {
  const problem = school({
    lessons: [lesson('x', ['s6a'], 'Maths', [part('main', ['t1'], [{ count: 40, length: 1 }])])],
  });
  const result = analyze(problem);
  expect(result.ok).toBe(false);
  expect(result.blocking.some((b) => /periods/.test(b.message))).toBe(true);
});

it('fit suggestions name the critical subject limit and include valid alternatives', () => {
  const schedule = new Schedule(school({
    lessons: [lesson('art', ['s6a'], 'Art', [part('main', ['t1'], [{ count: 2, length: 1 }])])],
  }));
  const [first, second] = [...schedule.blocks.keys()];
  expect(schedule.placeAt(first, 1, 1).ok).toBe(true);
  expect(schedule.placeAt(second, 2, 1).ok).toBe(true);
  const conflict = schedule.fitMap(first).find((slot) => slot.day === 2 && slot.first === 2)!;
  expect(conflict.ok).toBe(false);
  expect(conflict.reason).toMatch(/at most 1 Art lesson per day/);
  const refusal = schedule.move(first, 2, 2);
  expect(refusal.ok).toBe(false);
  expect(refusal.blockers[0].message).toBe(conflict.reason);
  expect(schedule.entries().find((entry) => entry.blockId === first).day).toBe(1);
  const alternative = schedule.fitMap(first).find((slot) => slot.day === 3 && slot.first === 1)!;
  expect(alternative.ok).toBe(true);
  expect(schedule.move(first, alternative.day, alternative.first).ok).toBe(true);
});

it('readiness blocks a lesson when no room has enough seats', () => {
  const problem = school({
    rooms: [{ id: 'lab1', name: 'Lab 1', capacity: 10 }],
    lessons: [lesson('science', ['s6a'], 'Science', [
      part('lab', ['t3'], [{ count: 1, length: 2 }], { room: { type: 'any' } }),
    ])],
  });
  const readiness = analyze(problem);
  expect(readiness.ok).toBe(false);
  expect(readiness.blocking.some(({ code, message }) => code === 'room_capacity' && message.includes('Science'))).toBe(true);
});

it('blocks an unfinished fixed room choice in readiness, generation and the editor', () => {
  const plannedLesson = lesson('science', ['s6a'], 'Science', [
    part('lab', ['t3'], [{ count: 1, length: 1 }], { room: { type: 'fixed', groupId: 'labs' } }),
  ]);
  const problem = school({ lessons: [plannedLesson] });
  expect(analyze(problem).blocking).toEqual([
    { code: 'no_room_choice', message: 'Science: choose which rooms it may use.' },
  ]);

  const generated = generate(problem, { seed: 1, budgetMs: 100 });
  expect(generated.entries).toEqual([]);
  expect(generated.unplaced).toHaveLength(1);

  const schedule = new Schedule(problem);
  const [blockId] = schedule.blocks.keys();
  expect(schedule.placeAt(blockId, 1, 1)).toMatchObject({
    ok: false,
    blockers: [{ kind: 'room', message: 'Science: choose which rooms it may use.' }],
  });

  const roomless = school({
    lessons: [{ ...plannedLesson, parts: [{ ...plannedLesson.parts[0], room: { type: 'none' } }] }],
  });
  const saved = generate(roomless, { seed: 1, budgetMs: 100 }).entries;
  expect(saved).toHaveLength(1);
  const restored = Schedule.fromEntries(problem, saved);
  expect(restored.entries()).toEqual([]);
  expect(restored.dropped).toHaveLength(1);
});

it('requires every fixed room even when the lesson also carries a group', () => {
  const problem = school({
    lessons: [lesson('science', ['s6a'], 'Science', [
      part('lab', ['t3'], [{ count: 1, length: 1 }], {
        room: { type: 'fixed', roomIds: ['lab1', 'lab2'], groupId: 'another-group' },
      }),
    ])],
  });
  const { entries } = generate(problem, { seed: 1, budgetMs: 100 });
  expect(entries).toHaveLength(1);
  expect(entries[0].roomIds).toEqual(['lab1', 'lab2']);

  const missingRoom = { ...problem, rooms: problem.rooms.filter(({ id }) => id !== 'lab2') };
  expect(generate(missingRoom, { seed: 1, budgetMs: 100 }).entries).toEqual([]);
  const schedule = new Schedule(missingRoom);
  const [blockId] = schedule.blocks.keys();
  expect(schedule.placeAt(blockId, 1, 1).ok).toBe(false);
});

it.each(['any', 'oneOf'] as const)('keeps %s room requirements inside an empty group', (type) => {
  const problem = school({
    lessons: [lesson('science', ['s6a'], 'Science', [
      part('lab', ['t3'], [{ count: 1, length: 1 }], { room: { type, groupId: 'empty' } }),
    ])],
  });
  expect(analyze(problem).blocking).toEqual([
    expect.objectContaining({ code: 'room_capacity' }),
  ]);
  const generated = generate(problem, { seed: 1, budgetMs: 100 });
  expect(generated.entries).toEqual([]);
  expect(generated.unplaced).toHaveLength(1);
});

/** Empty periods inside a class's day, and days that start after period 1. */
function classShape(schedule: Schedule) {
  let gaps = 0;
  let lateStarts = 0;
  for (const sid of schedule.sections.keys()) {
    const byDay = new Map<number, number[]>();
    for (const e of schedule.entries().filter((x: ScheduleEntry) => x.sectionId === sid)) {
      const list = byDay.get(e.day) || [];
      for (let k = 0; k < e.length; k += 1) list.push(e.startNo + k);
      byDay.set(e.day, list);
    }
    for (const nos of byDay.values()) {
      nos.sort((a, b) => a - b);
      gaps += nos[nos.length - 1] - nos[0] + 1 - nos.length;
      lateStarts += nos[0] - 1;
    }
  }
  return { gaps, lateStarts };
}

it('readiness warns about a class with no lessons and a class with unfilled periods', () => {
  const readiness = analyze(school({
    sections: [
      { id: 's6a', name: '6A', className: 'Grade 6', capacity: 30 },
      { id: 's6b', name: '6B', className: 'Grade 6', capacity: 30 },
      { id: 's7a', name: '7A', className: 'Grade 7', capacity: 30 },
    ],
    lessons: [lesson('eng', ['s6a'], 'English', [part('main', ['t2'], [{ count: 5, length: 1 }])])],
  }));
  const codes = readiness.warnings.map((w) => `${w.code}:${w.sectionId}`);
  expect(codes, codes.join()).toContain('section_empty:s6b');
  expect(codes, codes.join()).toContain('section_empty:s7a');
  const light = readiness.warnings.find((w) => w.code === 'section_light' && w.sectionId === 's6a')!;
  expect(light.message).toMatch(/5 of 35 periods planned, so 30 periods a week will stay empty/);
});

it('a fully planned class gets no empty-period warning', () => {
  const readiness = analyze(school({
    sections: [{ id: 's6a', name: '6A', className: 'Grade 6', capacity: 30 }],
    lessons: [lesson('all', ['s6a'], 'Everything', [part('main', ['t1'], [{ count: 35, length: 1 }])])],
    rules: { defaults: { subjectSpread: { value: 9, level: 'off' } } },
  }));
  expect(readiness.warnings.some((w) => w.code === 'section_light' || w.code === 'section_empty')).toBe(false);
});

it('compaction removes mid-day gaps and late starts that a short search leaves behind', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const result = generate(school(), { seed, budgetMs: 50, maxIterations: 40 });
    assertNoClashes(result.entries, `seed ${seed}: `);
    expect(result.unplaced.length).toBe(0);
    const { gaps, lateStarts } = classShape(result.schedule);
    expect(gaps, `seed ${seed} left ${gaps} gap(s)`).toBe(0);
    expect(lateStarts, `seed ${seed} left ${lateStarts} late start(s)`).toBe(0);
  }
});

it('compaction never moves a locked lesson', () => {
  const first = generate(school(), { seed: 1, budgetMs: 50 });
  const target = first.entries.find((e) => e.subjectName === 'English' && e.sectionId === 's6a')!;
  const locked = first.entries.map((e) => ({ ...e, locked: e.blockId === target.blockId }));
  const second = generate(school(), { seed: 4, budgetMs: 50, maxIterations: 40, lockedEntries: locked });
  const kept = second.entries.find((e) => e.blockId === target.blockId)!;
  expect(kept.day).toBe(target.day);
  expect(kept.startNo).toBe(target.startNo);
});

it('an empty period comes with the exact fix, naming who is in the way', () => {
  const schedule = new Schedule(school({
    lessons: [
      lesson('eng', ['s6a'], 'English', [part('main', ['t2'], [{ count: 3, length: 1 }])]),
      lesson('eng-b', ['s6b'], 'English', [part('main', ['t2'], [{ count: 1, length: 1 }])]),
    ],
    rules: { defaults: { subjectSpread: { value: 9, level: 'off' } } },
  }));
  expect(schedule.placeAt('eng:main:0', 1, 1).ok).toBe(true);
  expect(schedule.placeAt('eng:main:1', 1, 3).ok).toBe(true);
  expect(schedule.placeAt('eng:main:2', 2, 1).ok).toBe(true);
  expect(schedule.placeAt('eng-b:main:0', 1, 2).ok).toBe(true); // Ben teaches 6B in the hole
  const hole = schedule.emptyPeriods().find((item) => item.kind === 'gap')!;
  expect(hole.message).toMatch(/Grade 6 6A has an empty period 2 on Monday/);
  expect(hole.fix).toMatch(/Monday period 2/);
  expect(hole.fix).toMatch(/Ben/);
  expect(hole.fix).toMatch(/English for Grade 6 6B/);
});

it('a late start is reported with the period it should start in', () => {
  const schedule = new Schedule(school({
    lessons: [lesson('eng', ['s6a'], 'English', [part('main', ['t2'], [{ count: 2, length: 1 }])])],
    rules: { defaults: { subjectSpread: { value: 9, level: 'off' } } },
  }));
  schedule.placeAt('eng:main:0', 1, 3);
  schedule.placeAt('eng:main:1', 2, 1);
  const late = schedule.emptyPeriods().find((item) => item.kind === 'late_start')!;
  expect(late.message).toMatch(/empty periods 1–2 on Monday \(lessons start in period 3\)/);
  expect(late.fix).toMatch(/English/);
});

it('empty periods the plan can never fill say how many lessons to add', () => {
  const schedule = new Schedule(school({
    sections: [
      { id: 's6a', name: '6A', className: 'Grade 6', capacity: 30 },
      { id: 's7a', name: '7A', className: 'Grade 7', capacity: 30 },
    ],
    lessons: [lesson('eng', ['s6a'], 'English', [part('main', ['t2'], [{ count: 5, length: 1 }])])],
  }));
  const kinds = Object.fromEntries(schedule.emptyPeriods().map((item) => [item.kind, item]));
  expect(kinds.unfilled.message).toMatch(/Grade 6 6A has 5 of 35 periods planned, so 30 periods a week stay empty/);
  expect(kinds.unfilled.fix).toMatch(/Add 30 more periods to Grade 6 6A's teaching plan/);
  expect(kinds.blank.fix).toMatch(/Teaching plan step/);
});

it('lessons that run at the same time share one slot when counting a class\'s periods', () => {
  const problem = school({
    sections: [{ id: 's6a', name: '6A', className: 'Grade 6', capacity: 30 }],
    lessons: [
      lesson('french', ['s6a'], 'French', [part('main', ['t1'], [{ count: 3, length: 1 }])], { syncGroup: 'second' }),
      lesson('hindi', ['s6a'], 'Hindi', [part('main', ['t2'], [{ count: 3, length: 1 }])], { syncGroup: 'second' }),
      lesson('eng', ['s6a'], 'English', [part('main', ['t3'], [{ count: 5, length: 1 }])]),
    ],
  });
  expect(new Schedule(problem).sectionLoad('s6a')).toEqual({ planned: 8, capacity: 35 });
  expect(analyze(problem).warnings.some((w) => /8 of 35 periods planned/.test(w.message))).toBe(true);
});

it('a class never starts late just to spare a teacher a free period', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const result = generate(school(), { seed, budgetMs: 50, maxIterations: 40 });
    const { gaps, lateStarts } = classShape(result.schedule);
    expect(gaps + lateStarts, `seed ${seed}`).toBe(0);
    expect(result.schedule.emptyPeriods().filter((i) => i.kind === 'gap' || i.kind === 'late_start').length, `seed ${seed}`).toBe(0);
  }
});

/** Ten classes, six subjects, sixteen teachers who each teach two subjects: the tight school that exposed the bug. */
function tightSchool(): Problem {
  const periods = Array.from({ length: 8 }, (_, i) => period(i + 1, `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`));
  const subjects: [string, { count: number; length: number }[]][] = [
    ['Tamil', [{ count: 7, length: 1 }]], ['English', [{ count: 7, length: 1 }]], ['Mathematics', [{ count: 7, length: 1 }]],
    ['Science', [{ count: 5, length: 1 }, { count: 1, length: 2 }]], ['Social Science', [{ count: 6, length: 1 }]],
    ['Computer Science', [{ count: 2, length: 2 }, { count: 2, length: 1 }]],
  ];
  const sections: Problem['sections'] = [];
  for (const g of [6, 7, 8, 9, 10]) for (const l of ['A', 'B']) sections.push({ id: `s${g}${l}`, name: l, className: `Grade ${g}`, capacity: 40 });
  const staff: Problem['staff'] = [];
  const make = (prefix: string, n: number) => Array.from({ length: n }, (_, k) => { const id = `${prefix}${k}`; staff.push({ id, name: id }); return id; });
  const tamilSocial = make('ts', 5); const englishComputer = make('ec', 5); const maths = make('ma', 3); const science = make('sc', 3);
  const teacherOf = (si: number, i: number) => [tamilSocial[Math.floor(i / 2)], englishComputer[Math.floor(i / 2)], maths[i % 3], science[i % 3], tamilSocial[(Math.floor(i / 2) + 1) % 5], englishComputer[(Math.floor(i / 2) + 1) % 5]][si];
  const lessons = subjects.flatMap(([name, pattern], si) => sections.map((s, i) => lesson(`l-${s.id}-${si}`, [s.id], name, [part('main', [teacherOf(si, i)], pattern)])));
  return { days: [1, 2, 3, 4, 5], bell: { weekType: 'weekly', dayTypes: [{ id: 'u', name: 'Usual', days: [1, 2, 3, 4, 5], periods }] }, sections, staff, rooms: [], availability: {}, rules: {}, lessons };
}

/** Number of broken critical ("never") rules in a schedule. */
function brokenCriticalRules(schedule: Schedule) {
  let broken = 0;
  const count = (rule: { w: number }, n: number) => { if (rule.w >= CRITICAL && n > 0) broken += n; };
  for (const id of schedule.sections.keys()) schedule.sectionPenalty(id, count);
  for (const id of schedule.staff.keys()) schedule.teacherPenalty(id, count);
  return broken;
}

it('a critical rule is never broken, even by a move that also improves a soft preference', () => {
  // Such a move scores 1,000,000 minus a little, which used to slip under the "is it critical?" test.
  for (const seed of [1, 2, 3, 4]) {
    const schedule = new Schedule(tightSchool(), { seed });
    schedule.place();
    expect(brokenCriticalRules(schedule), `seed ${seed}: "at most 2 of one subject a day" was broken during placement`).toBe(0);
  }
  const result = generate(tightSchool(), { seed: 5, budgetMs: 200 });
  expect(brokenCriticalRules(result.schedule), 'and it stays unbroken through the search and tidy-up').toBe(0);
  assertNoClashes(result.entries);
});

// ------------------------------------------------------------ teaching profile

const withStaff = (staff: Problem['staff']) => ({ staff: staff.map((t) => ({ subjectIds: [], primarySubjectId: null, maxPeriodsPerWeek: null, ...t })) });
const sharedFive = () => lesson('shared', ['s6a', 's6b'], 'Maths', [part('main', ['t1'], [{ count: 5, length: 1 }])]);
const science = (teacher: string) => [
  lesson('sci-a', ['s6a'], 'Science', [part('main', [teacher], [{ count: 6, length: 1 }])]),
  lesson('sci-b', ['s6b'], 'Science', [part('main', [teacher], [{ count: 6, length: 1 }])]),
];

it('a teacher over their maximum blocks generation with the exact fix', () => {
  const result = analyze(school(withStaff([{ id: 't1', name: 'Anjali', maxPeriodsPerWeek: 9 }, { id: 't2', name: 'Ben' }, { id: 't3', name: 'Chen' }])));
  const found = result.blocking.find((b) => b.code === 'teacher_max')!;
  expect(found, 'teacher_max is raised').toBeDefined();
  expect(found.message).toBe('Anjali has 12 periods a week but a maximum of 9. Remove 3 periods in the Teaching plan.');
  expect(found.teacherId).toBe('t1');
  expect(result.ok).toBe(false);
});

it('a teacher exactly at their maximum is fine, and no maximum means no limit', () => {
  const atMax = analyze(school(withStaff([{ id: 't1', name: 'Anjali', maxPeriodsPerWeek: 12 }, { id: 't2', name: 'Ben' }, { id: 't3', name: 'Chen' }])));
  expect(atMax.blocking.some((b) => b.code === 'teacher_max')).toBe(false);
  const unlimited = analyze(school(withStaff([{ id: 't1', name: 'Anjali', maxPeriodsPerWeek: null }, { id: 't2', name: 'Ben' }, { id: 't3', name: 'Chen' }])));
  expect(unlimited.blocking.some((b) => b.code === 'teacher_max')).toBe(false);
});

it('a lesson shared by two classes counts once toward a teacher maximum', () => {
  const problem = school({ ...withStaff([{ id: 't1', name: 'Anjali', maxPeriodsPerWeek: 5 }]), lessons: [sharedFive()] });
  expect(analyze(problem).blocking.some((b) => b.code === 'teacher_max')).toBe(false);
  expect(teacherLoads(problem).get('t1')).toBe(5);
});

it('a subject short of teachers is a warning, not a block', () => {
  const problem = school({
    ...withStaff([{ id: 't1', name: 'Anjali' }, { id: 't3', name: 'Chen', subjectIds: ['sub-Science'], maxPeriodsPerWeek: 4 }, { id: 't4', name: 'Dina', subjectIds: ['sub-Science'], maxPeriodsPerWeek: 4 }]),
    lessons: science('t1'),
  });
  const result = analyze(problem);
  const warning = result.warnings.find((w) => w.code === 'subject_shortage')!;
  expect(warning, 'subject_shortage is raised').toBeDefined();
  expect(warning.message).toBe("Science needs 12 periods a week; teachers who can teach it can give 8. You are 4 short. Add Science to another teacher's profile or raise a maximum.");
  expect(result.ok).toBe(true);
});

it('no shortage is reported when a listed teacher is unlimited or nobody lists the subject', () => {
  const unlimited = analyze(school({
    ...withStaff([{ id: 't1', name: 'Anjali' }, { id: 't3', name: 'Chen', subjectIds: ['sub-Science'], maxPeriodsPerWeek: 4 }, { id: 't4', name: 'Dina', subjectIds: ['sub-Science'], maxPeriodsPerWeek: null }]),
    lessons: science('t1'),
  }));
  expect(unlimited.warnings.some((w) => w.code === 'subject_shortage')).toBe(false);
  const nobody = analyze(school({ ...withStaff([{ id: 't1', name: 'Anjali' }]), lessons: science('t1') }));
  expect(nobody.warnings.some((w) => w.code === 'subject_shortage')).toBe(false);
});

it('a lesson that has simply not been placed yet is not reported as blocked by a rule', () => {
  const schedule = new Schedule(school());
  const unplaced = schedule.unplaced();
  expect(unplaced.length).toBeGreaterThan(0);
  for (const u of unplaced) {
    expect(u.reasons).toEqual(['A free slot exists. Place it by hand or press Auto-fill the rest.']);
    expect(u.placeable, 'flagged so screens show it as information, not an error').toBe(true);
  }
});

// ------------------------------------------------------------ swapping lessons

/** Hours (periods) a teacher sits idle between their first and last lesson of a day. */
const idleGaps = (schedule: Schedule, teacherId: string) => {
  const byDay = new Map<number, Set<number>>();
  for (const e of schedule.entries()) {
    if (!e.teacherIds.includes(teacherId)) continue;
    const set = byDay.get(e.day) ?? new Set<number>();
    byDay.set(e.day, set);
    for (let k = 0; k < e.length; k += 1) set.add(e.startNo + k);
  }
  let gaps = 0;
  for (const set of byDay.values()) { const p = [...set].sort((a, b) => a - b); gaps += p[p.length - 1] - p[0] + 1 - p.length; }
  return gaps;
};

function fullClassesProblem(): Problem {
  const oneDay = { weekType: 'weekly', dayTypes: [{ id: 'd', name: 'Day', days: [1], periods: [period(1, '08:00', '08:45'), period(2, '08:45', '09:30'), period(3, '09:30', '10:15'), period(4, '10:15', '11:00')] }] };
  const staff = ['T', 'A1', 'A2', 'A3', 'B1', 'B2', 'B3'].map((id) => ({ id, name: id }));
  const classLessons = (sec: string, prefix: string) => ['1', '2', '3'].map((n) => lesson(`${prefix}${n}`, [sec], `${prefix}${n}`, [part('main', [`${prefix}${n}`], [{ count: 1, length: 1 }])]));
  return {
    days: [1], bell: oneDay, sections: [{ id: 'sA', name: 'A', className: 'G', capacity: 30 }, { id: 'sB', name: 'B', className: 'G', capacity: 30 }],
    staff, rooms: [], availability: {}, rules: {},
    lessons: [lesson('mA', ['sA'], 'Maths', [part('main', ['T'], [{ count: 1, length: 1 }])]), lesson('mB', ['sB'], 'Maths', [part('main', ['T'], [{ count: 1, length: 1 }])]), ...classLessons('sA', 'A'), ...classLessons('sB', 'B')],
  };
}

it('weekly limits apply to flexible teachers when the other choice is blocked', () => {
  const problem = school({
    staff: [{ id: 't1', name: 'First teacher', maxPeriodsPerWeek: 1 }, { id: 't2', name: 'Second teacher', maxPeriodsPerWeek: 1 }],
    lessons: [lesson('art', ['s6a'], 'Art', [part('main', ['t1', 't2'], [{ count: 2, length: 1 }], { mode: 'one_of' })])],
  });
  const day = problem.bell.dayTypes[0];
  problem.availability = { staff: { t2: day.days.flatMap((d) => day.periods.filter((p) => !p.isBreak).map((_p, i) => ({ day: d, period: i + 1 }))) } };
  const result = generate(problem, { seed: 1, budgetMs: 100 });
  expect(result.entries.length).toBe(1);
  expect(result.unplaced.length).toBe(1);
  expect(result.unplaced[0].reasons.join(' ')).toMatch(/weekly limit/);
});

it('a blocked duty does not count toward the usable free period on a shorter day', () => {
  const problem = school({
    days: [1],
    bell: bell([1]),
    availability: { staff: { t1: [{ day: 1, period: 2 }] } },
    rules: { defaults: { teacherMinFreePerDay: { value: 1, level: 'critical' } } },
    lessons: [lesson('art', ['s6a'], 'Art', [part('main', ['t1'], [{ count: 2, length: 1 }])])],
  });
  problem.bell.dayTypes[0].periods = problem.bell.dayTypes[0].periods.filter((row) => !row.isBreak).slice(0, 3);
  const schedule = new Schedule(problem);
  const [first, second] = [...schedule.blocks.keys()];
  expect(schedule.placeAt(first, 1, 1).ok).toBe(true);
  const rejected = schedule.placeAt(second, 1, 3);
  expect(rejected.ok).toBe(false);
  expect(rejected.blockers[0].message).toMatch(/available free period/);
});

it('a full class can still be rearranged: swapping two lessons removes a teacher gap', () => {
  const schedule = new Schedule(fullClassesProblem(), { seed: 3 });
  const block = (sec: string, name: string) => [...schedule.blocks.values()].find((b) => b.sectionIds[0] === sec && b.subjectName === name).id;
  // Class A: Maths first, then its three other lessons. Class B: three other lessons, then Maths last.
  const arrangement: [string, string, number][] = [['sA', 'Maths', 1], ['sA', 'A1', 2], ['sA', 'A2', 3], ['sA', 'A3', 4], ['sB', 'B1', 1], ['sB', 'B2', 2], ['sB', 'B3', 3], ['sB', 'Maths', 4]];
  for (const [sec, name, no] of arrangement) expect(schedule.placeAt(block(sec, name), 1, no).ok, `${name} placed`).toBe(true);
  expect(idleGaps(schedule, 'T'), 'the teacher starts with a two-period gap, and no class has a free period to move into').toBe(2);
  schedule.optimize({ budgetMs: 500, maxIterations: 3000 });
  expect(idleGaps(schedule, 'T'), 'swapping two of class B\'s lessons closes the gap').toBe(0);
  expect(schedule.unplaced().length, 'and nothing was lost').toBe(0);
  assertNoClashes(schedule.entries());
});

// ------------------------------------------------------------ long days

/** One teacher, one class, an 8-period day with no breaks; `counts` is how many lessons T teaches each day. */
function longDayProblem(counts: number[], rules: RuleSet): Problem {
  const periods = Array.from({ length: 8 }, (_, i) => period(i + 1, `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`));
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    days: counts.map((_, i) => i + 1),
    bell: { weekType: 'weekly', dayTypes: [{ id: 'd', name: 'Day', days: counts.map((_, i) => i + 1), periods }] },
    sections: [{ id: 'sA', name: 'A', className: 'G', capacity: 30 }],
    staff: [{ id: 'T', name: 'Teacher T' }], rooms: [], availability: {},
    rules: { defaults: { teacherMaxInRow: { value: 3, level: 'off' }, teacherNoGaps: { value: true, level: 'off' }, ...rules }, teachers: {}, sections: {} },
    lessons: Array.from({ length: total }, (_, i) => lesson(`l${i}`, ['sA'], `S${i}`, [part('main', ['T'], [{ count: 1, length: 1 }])])),
  };
}

function teacherPenaltyFor(counts: number[], rules: RuleSet) {
  const schedule = new Schedule(longDayProblem(counts, rules));
  const blocks = [...schedule.blocks.values()];
  let next = 0;
  counts.forEach((count, i) => { for (let no = 1; no <= count; no += 1) expect(schedule.placeAt(blocks[next++].id, i + 1, no).ok).toBe(true); });
  return schedule.teacherPenalty('T');
}

const sixHigh: RuleSet = { teacherMaxPerDay: { value: 6, level: 'high' } };
const longDays = (value: number, level: RuleLevel = 'high'): RuleSet => ({ teacherLongDays: { value, level } });

it('a long day is one period over the daily maximum, allowed on a few days a week', () => {
  expect(teacherPenaltyFor([7, 6], { ...sixHigh, ...longDays(2, 'off') }), 'with the rule off, 7 in a day is over the maximum').toBe(50);
  expect(teacherPenaltyFor([7, 6], { ...sixHigh, ...longDays(2) }), 'one long day is within two allowed').toBe(0);
  expect(teacherPenaltyFor([7, 7, 6], { ...sixHigh, ...longDays(2) }), 'two long days are within two allowed').toBe(0);
  expect(teacherPenaltyFor([7, 7, 7], { ...sixHigh, ...longDays(2) }), 'a third long day costs like an overloaded day').toBe(50);
  expect(teacherPenaltyFor([7, 7, 7], { ...sixHigh, ...longDays(2, 'off') }), 'without the rule all three are over the maximum').toBe(150);
});

it('a day two periods over the maximum is still overloaded, even on a long-day allowance', () => {
  expect(teacherPenaltyFor([8, 6], { ...sixHigh, ...longDays(2) }), 'only the period beyond the one allowed extra counts').toBe(50);
});

it('long days do nothing when the daily maximum is Critical', () => {
  const schedule = new Schedule(longDayProblem([7], { teacherMaxPerDay: { value: 6, level: 'critical' }, ...longDays(2) }));
  const blocks = [...schedule.blocks.values()];
  for (let no = 1; no <= 6; no += 1) expect(schedule.placeAt(blocks[no - 1].id, 1, no).ok).toBe(true);
  const seventh = schedule.placeAt(blocks[6].id, 1, 7);
  expect(seventh.ok, 'a Critical maximum still refuses the seventh period').toBe(false);
  expect(seventh.blockers[0].message).toMatch(/daily limit of 6/);
});

it('a Critical long-day limit is never exceeded by the search', () => {
  const problem = longDayProblem([7, 7, 7, 4], { ...sixHigh, ...longDays(1, 'critical') });
  const result = generate(problem, { seed: 4, budgetMs: 400 });
  const perDay = new Map<number, number>();
  for (const e of result.entries) perDay.set(e.day, (perDay.get(e.day) ?? 0) + e.length);
  const longs = [...perDay.values()].filter((n) => n > 6).length;
  expect(longs, `at most one day over 6, got ${longs}`).toBeLessThanOrEqual(1);
  assertNoClashes(result.entries);
});

it('the overload warning allows for long days', () => {
  const fiveDays = [1, 2, 3, 4, 5];
  const demand = 32; // 6 a day for five days is 30; two long days make 32.
  const build = (longRule: RuleSet): Problem => {
    const periods = Array.from({ length: 8 }, (_, i) => period(i + 1, `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`));
    return {
      days: fiveDays, bell: { weekType: 'weekly', dayTypes: [{ id: 'd', name: 'Day', days: fiveDays, periods }] },
      sections: [{ id: 'sA', name: 'A', className: 'G', capacity: 30 }, { id: 'sB', name: 'B', className: 'G', capacity: 30 }],
      staff: [{ id: 'T', name: 'Teacher T' }], rooms: [], availability: {},
      rules: { defaults: { teacherMaxPerDay: { value: 6, level: 'high' }, ...longRule }, teachers: {}, sections: {} },
      lessons: Array.from({ length: demand }, (_, i) => lesson(`l${i}`, [i % 2 ? 'sB' : 'sA'], `S${i}`, [part('main', ['T'], [{ count: 1, length: 1 }])])),
    };
  };
  expect(analyze(build(longDays(2, 'off'))).warnings.some((w) => w.code === 'teacher_overload'), 'flat 6 a day: 32 periods is too many').toBe(true);
  expect(analyze(build(longDays(2))).warnings.some((w) => w.code === 'teacher_overload'), 'two long days: 32 periods fits').toBe(false);
  expect(analyze(build(longDays(1))).warnings.some((w) => w.code === 'teacher_overload'), 'one long day: 31 is the most').toBe(true);
});

// ------------------------------------------------------------ worker thread

/** The 5-section sample school: Monday to Friday, 8 teaching periods a day, 7 teachers, 6 subjects of 5 periods a week each. */
function sampleSchoolProblem(): Problem {
  const days = [1, 2, 3, 4, 5];
  const periods = Array.from({ length: 8 }, (_, i) => period(i + 1, `${String(8 + i).padStart(2, '0')}:00`, `${String(8 + i).padStart(2, '0')}:45`));
  const sections = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ id: `s${name}`, name, className: 'Grade 6', capacity: 40 }));
  const staff = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, name: `Teacher ${i}` }));
  const subjects = ['Tamil', 'English', 'Mathematics', 'Science', 'Social Science', 'Computer Science'];
  const lessons = sections.flatMap((s, si) =>
    subjects.map((name, ji) => lesson(`l-${s.id}-${ji}`, [s.id], name, [part('main', [staff[(si + ji) % staff.length].id], [{ count: 5, length: 1 }])])),
  );
  return { days, bell: { weekType: 'weekly', dayTypes: [{ id: 'usual', name: 'Usual day', days, periods }] }, sections, staff, rooms: [], availability: {}, rules: {}, lessons };
}

describe('generateInWorker', () => {
  it('generateInWorker returns a complete schedule for the 5-section sample problem', async () => {
    const result = await generateInWorker(sampleSchoolProblem(), { seed: 1, budgetMs: 300, maxIterations: 200 }, { timeoutMs: 30_000 });
    expect(result.unplaced, JSON.stringify(result.unplaced)).toEqual([]);
    expect(result.stats.totalPeriods).toBe(150);
    expect(result.stats.placedPeriods).toBe(150);
    expect(result.entries).toHaveLength(150);
    assertNoClashes(result.entries);
  });
});
