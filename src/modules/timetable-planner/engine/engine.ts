/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, no-unused-private-class-members -- ported from the planner prototype (see the note below) */
// @ts-nocheck - ported from the planner prototype; the exported signatures below are typed, the 1,500-line body is not.
/*
 * Provenance: this engine started as a port of the dummy project's server/timetable/engine.js and now deliberately differs from it in:
 *  - needsRoomChoice is reported for `fixed` lessons that have no rooms;
 *  - an empty room group no longer falls back to all rooms;
 *  - deleted or inactive room ids are rejected by need('room');
 *  - bad_subject / bad_teacher readiness issues carry names (inactiveTeacherNames / subjectMissing);
 *  - an empty-string groupId counts as a group.
 * Any future port of changes from the dummy engine must be diffed against these differences, not copied over the file.
 */
/**
 * Timetable engine — pure JavaScript, no HTTP, no database, no clock except for the
 * optimisation budget. Everything it needs comes in as one plain `problem` object and
 * everything it produces is plain JSON, so it can run in Node, a Web Worker, or be
 * replaced later by another solver behind the same shape.
 *
 * Vocabulary
 *   lesson  one row of the teaching plan: sections + subject (or activity) + parts
 *   part    a slice of a lesson with its own weekly pattern, teachers and room rule
 *           (theory vs lab, or "Mr X takes 4 periods and Ms Y takes 2")
 *   unit    one placement of a part: a single or a multi-period (double, triple) lesson
 *   block   units that must be placed in the SAME slot (parallel / same-time lessons).
 *           Most blocks hold a single unit.
 *   period  teaching periods are numbered 1..n per day, breaks are not numbered.
 */

export type RuleLevel = 'off' | 'low' | 'medium' | 'high' | 'critical';
export interface Rule {
  value: number | boolean;
  level: RuleLevel;
}
export type RuleSet = Record<string, Rule>;
export interface BlockedSlot {
  day: number;
  period: number;
}
export interface BellPeriod {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  isBreak: boolean;
}
export interface Bell {
  weekType: string;
  dayTypes: { id: string; name: string; days: number[]; periods: BellPeriod[] }[];
}
export interface RoomRule {
  type: 'none' | 'fixed' | 'oneOf' | 'any';
  roomIds?: string[];
  groupId?: string | null;
}
export interface LessonPart {
  id: string;
  label?: string;
  teacherIds: string[];
  mode: 'together' | 'one_of';
  pattern: { count: number; length: number }[];
  room: RoomRule;
}
export interface Lesson {
  id: string;
  sectionIds: string[];
  subjectId?: string | null;
  subjectName?: string;
  subjectMissing?: boolean;
  activityName?: string | null;
  syncGroup?: string | null;
  parts: LessonPart[];
}

/** Everything the engine needs, as plain data: the shape the planner store builds for one academic year. */
export interface Problem {
  days: number[];
  bell: Bell;
  sections: { id: string; name: string; className?: string; capacity?: number | null }[];
  staff: {
    id: string;
    name: string;
    primarySubjectId?: string | null;
    subjectIds?: string[];
    maxPeriodsPerWeek?: number | null;
  }[];
  inactiveTeacherNames?: Record<string, string>;
  rooms: { id: string; name: string; groupId?: string | null; capacity?: number | null; type?: string | null; blocked?: BlockedSlot[] }[];
  availability: { staff?: Record<string, BlockedSlot[]>; section?: Record<string, BlockedSlot[]>; room?: Record<string, BlockedSlot[]> };
  rules: { defaults?: RuleSet; teachers?: Record<string, RuleSet>; sections?: Record<string, RuleSet> };
  lessons: Lesson[];
}

/** One lesson placed on the timetable, as stored and sent over the wire. */
export interface ScheduleEntry {
  id: string;
  blockId: string;
  sectionId: string;
  subjectId: string | null;
  subjectName: string;
  teacherIds: string[];
  roomIds: string[];
  day: number;
  startNo: number;
  length: number;
  locked?: boolean;
  [key: string]: unknown;
}

export interface GenerateOptions {
  seed?: number;
  budgetMs?: number;
  maxIterations?: number;
  lockedEntries?: ScheduleEntry[];
  shouldStop?: () => boolean;
  onProgress?: (progress: unknown) => void;
}

/** The part of a generation that is plain JSON, which is what a worker thread can hand back. */
export interface GenerateOutput {
  entries: ScheduleEntry[];
  unplaced: { reasons: string[]; [key: string]: unknown }[];
  stats: { placedPeriods: number; totalPeriods: number; ms: number; [key: string]: unknown };
  warnings: string[];
}

export interface ReadinessIssue {
  code: string;
  message: string;
  sectionId?: string;
  teacherId?: string;
  subjectId?: string;
}
export interface Readiness {
  ok: boolean;
  blocking: ReadinessIssue[];
  warnings: ReadinessIssue[];
  summary: { lessons: number; periods: number; sections: number; teachers: number; days: number };
}

/** Weight of a broken rule. "critical" is effectively a hard constraint. */
export const CRITICAL = 1_000_000;
/**
 * A move whose score change reaches this breaks a critical rule. It is half of CRITICAL, not CRITICAL,
 * because a move that breaks a rule can also improve soft preferences by a little (about 18 is enough);
 * its net score of 999,982 then slipped under a `>= CRITICAL` test and the rule was broken unnoticed.
 */
export const HARD = CRITICAL / 2;
/** How much worse (in penalty points) a swap may be and still be tried at the start of a search; cools to zero. */
const SWAP_START_TEMPERATURE = 3;
const FREE_SLOT_REASON = 'A free slot exists. Place it by hand or press Auto-fill the rest.';
const WEIGHT = { off: 0, low: 2, medium: 10, high: 50, critical: CRITICAL };
export const RULE_LEVELS: RuleLevel[] = ['off', 'low', 'medium', 'high', 'critical'];

export const DEFAULT_RULES: RuleSet = {
  teacherMaxPerDay: { value: 6, level: 'high' },
  // A "long day" is one period over the daily maximum. This many are allowed per teacher each week.
  teacherLongDays: { value: 2, level: 'high' },
  teacherMinFreePerDay: { value: 1, level: 'off' },
  teacherMaxInRow: { value: 3, level: 'high' },
  teacherNoGaps: { value: true, level: 'low' },
  classNoGaps: { value: true, level: 'high' },
  classStartsPeriod1: { value: true, level: 'medium' },
  subjectSpread: { value: 1, level: 'critical' },
  dayBalance: { value: true, level: 'medium' },
};

const slot = (day, no) => day * 100 + no;
const DAY_NAMES = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTeaching(periods) {
  const out = [];
  let no = 0;
  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (p.isBreak) continue;
    no += 1;
    const next = periods[i + 1];
    out.push({
      no,
      id: p.id,
      name: p.name,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      joinsNext: Boolean(next) && !next.isBreak,
    });
  }
  return out;
}

export function unitKey(lessonId: string, partId: string, index: number): string {
  return `${lessonId}:${partId}:${index}`;
}

function needsRoomChoice(room: LessonPart['room'] | undefined) {
  return !room?.roomIds?.length &&
    (room?.type === 'fixed' || (room?.type === 'oneOf' && room.groupId == null));
}

export class Schedule {
  // The class body is untyped (see the ts-nocheck note), so callers may use any of its members.
  [member: string]: any;

  constructor(problem: Problem, { seed = 1 }: { seed?: number } = {}) {
    this.problem = problem;
    this.rng = mulberry32(seed);
    this.warnings = [];

    this.sections = new Map((problem.sections || []).map((s) => [String(s.id), s]));
    this.staff = new Map((problem.staff || []).map((s) => [String(s.id), s]));
    this.rooms = new Map((problem.rooms || []).map((r) => [String(r.id), r]));

    this.rules = {
      defaults: { ...DEFAULT_RULES, ...(problem.rules?.defaults || {}) },
      teachers: problem.rules?.teachers || {},
      sections: problem.rules?.sections || {},
    };

    // Teaching periods per taught day.
    this.periodsByDay = new Map();
    for (const dayType of problem.bell?.dayTypes || []) {
      for (const day of dayType.days || []) {
        this.periodsByDay.set(Number(day), buildTeaching(dayType.periods || []));
      }
    }
    this.days = [...this.periodsByDay.keys()].sort((a, b) => a - b);

    // Availability: "this teacher/section/room cannot be used then".
    this.blocked = { teacher: new Map(), section: new Map(), room: new Map() };
    const addBlocked = (kind, id, list) => {
      const set = this.blocked[kind].get(String(id)) || new Set();
      for (const item of list || []) set.add(slot(Number(item.day), Number(item.period)));
      this.blocked[kind].set(String(id), set);
    };
    for (const [id, list] of Object.entries(problem.availability?.staff || {})) addBlocked('teacher', id, list);
    for (const [id, list] of Object.entries(problem.availability?.section || {})) addBlocked('section', id, list);
    for (const [id, list] of Object.entries(problem.availability?.room || {})) addBlocked('room', id, list);
    for (const room of problem.rooms || []) if (room.blocked?.length) addBlocked('room', room.id, room.blocked);

    this.busy = { teacher: new Map(), section: new Map(), room: new Map() };
    this.placements = new Map();

    this.#buildBlocks(problem.lessons || []);
  }

  // ---------------------------------------------------------------- blocks

  #buildBlocks(lessons) {
    const units = [];
    const groups = new Map();
    for (const lesson of lessons) {
      const sectionIds = (lesson.sectionIds || []).map(String);
      const lessonUnits = [];
      for (const part of lesson.parts || []) {
        let index = 0;
        for (const pattern of part.pattern || []) {
          for (let c = 0; c < Number(pattern.count || 0); c += 1) {
            lessonUnits.push({
              key: unitKey(lesson.id, part.id, index),
              lessonId: lesson.id,
              partId: part.id,
              label: part.label || '',
              length: Math.max(1, Number(pattern.length || 1)),
              sectionIds,
              subjectId: lesson.subjectId ?? null,
              subjectName: lesson.subjectName || lesson.activityName || 'Lesson',
              spreadKey: lesson.subjectId ? String(lesson.subjectId) : `act:${lesson.activityName || lesson.id}`,
              teacherIds: (part.teacherIds || []).map(String),
              mode: part.mode === 'one_of' ? 'one_of' : 'together',
              room: part.room || { type: 'none' },
            });
            index += 1;
          }
        }
      }
      if (lesson.syncGroup) {
        const list = groups.get(lesson.syncGroup) || [];
        list.push(lessonUnits);
        groups.set(lesson.syncGroup, list);
      } else {
        units.push(...lessonUnits.map((u) => [u]));
      }
    }

    const sorted = (list) => [...list].sort((a, b) => b.length - a.length || a.key.localeCompare(b.key));
    for (const [group, lessonUnitLists] of groups) {
      const lists = lessonUnitLists.map(sorted);
      const size = lists[0]?.length ?? 0;
      const aligned =
        lists.every((l) => l.length === size) &&
        lists[0].every((u, i) => lists.every((l) => l[i].length === u.length));
      if (aligned) {
        for (let i = 0; i < size; i += 1) units.push(lists.map((l) => l[i]));
      } else {
        this.warnings.push(`Same-time group "${group}" has different lesson counts or lengths, so its lessons are scheduled separately.`);
        for (const l of lists) units.push(...l.map((u) => [u]));
      }
    }

    this.blocks = new Map();
    for (const members of units) {
      const block = {
        id: members[0].key,
        units: members,
        length: members[0].length,
        sectionIds: [...new Set(members.flatMap((u) => u.sectionIds))],
        subjectName: members.map((u) => u.subjectName).join(' / '),
      };
      this.blocks.set(block.id, block);
    }

    // Per class-and-subject cap so "one lesson a day" never makes a 6-period subject impossible.
    this.subjectCap = new Map();
    const counts = new Map();
    for (const block of this.blocks.values()) {
      for (const u of block.units) {
        for (const sid of u.sectionIds) {
          const k = `${sid}|${u.spreadKey}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
    for (const [k, n] of counts) this.subjectCap.set(k, Math.ceil(n / Math.max(1, this.days.length)));
  }

  // ------------------------------------------------------------- resolving

  nameOf(kind, id) {
    if (kind === 'teacher') return this.staff.get(String(id))?.name ?? String(id);
    if (kind === 'section') {
      const s = this.sections.get(String(id));
      return s ? `${s.className ? `${s.className} ` : ''}${s.name}`.trim() : String(id);
    }
    return this.rooms.get(String(id))?.name ?? String(id);
  }

  #busyAt(kind, id, slots, ignore) {
    const map = this.busy[kind].get(String(id));
    if (!map) return null;
    for (const s of slots) {
      const hit = map.get(s);
      if (hit && hit.b !== ignore) return hit;
    }
    return null;
  }

  #isBlocked(kind, id, slots) {
    const set = this.blocked[kind].get(String(id));
    return Boolean(set) && slots.some((s) => set.has(s));
  }

  #load(kind, id) {
    return this.busy[kind].get(String(id))?.size ?? 0;
  }

  #availableTeachingSlots(id, day) {
    const blocked = this.blocked.teacher.get(String(id));
    return (this.periodsByDay.get(day) || []).filter(({ no }) => !blocked?.has(slot(day, no))).length;
  }

  teacherCapacity(id) {
    const daily = this.#weight('teacherMaxPerDay', 'teacher', id);
    const free = this.#weight('teacherMinFreePerDay', 'teacher', id);
    return this.days.reduce((total, day) => {
      const available = this.#availableTeachingSlots(id, day);
      const usable = free.w === CRITICAL ? Math.max(0, available - free.value) : available;
      return total + (daily.w === CRITICAL ? Math.min(daily.value, usable) : usable);
    }, 0);
  }

  #roomCandidates(unit) {
    const rule = unit.room || { type: 'none' };
    if (rule.type === 'fixed') return { required: (rule.roomIds || []).map(String), pool: [] };
    if (rule.type === 'oneOf' || rule.type === 'any') {
      let pool = (rule.roomIds || []).map(String);
      if (rule.groupId != null) {
        const groupRooms = [...this.rooms.values()]
          .filter((room) => String(room.groupId) === String(rule.groupId))
          .map((room) => String(room.id));
        pool = [...new Set([...pool, ...groupRooms])];
      } else if (rule.type === 'any' && pool.length === 0) {
        pool = [...this.rooms.keys()];
      }
      if (rule.type === 'any') {
        const need = Math.max(0, ...unit.sectionIds.map((s) => Number(this.sections.get(s)?.capacity || 0)));
        pool = pool.filter((id) => !this.rooms.get(id)?.capacity || this.rooms.get(id).capacity >= need);
      }
      return { required: [], pool };
    }
    return { required: [], pool: [] };
  }

  /**
   * Can this block start at (day, firstPeriod)? On success returns who teaches and where.
   * On failure returns every blocker so the UI and the "why unscheduled" report can name them.
   */
  resolve(block, day, first, { ignore = null, preferred = null, relaxCritical = false } = {}) {
    const blockers = [];
    const periods = this.periodsByDay.get(day);
    if (!periods) return { ok: false, blockers: [{ kind: 'day', reason: 'closed' }], assign: [] };
    const last = first + block.length - 1;
    if (first < 1 || last > periods.length) return { ok: false, blockers: [{ kind: 'period', reason: 'range' }], assign: [] };
    for (let k = 0; k < block.length - 1; k += 1) {
      if (!periods[first - 1 + k].joinsNext) return { ok: false, blockers: [{ kind: 'period', reason: 'break' }], assign: [] };
    }

    const slots = Array.from({ length: block.length }, (_, k) => slot(day, first + k));
    const reserved = { teacher: new Set(), room: new Set(), section: new Set() };
    const assign = [];

    const need = (kind, id) => {
      // Lessons in one same-time set split a class between them, so they share its slot.
      if (kind !== 'section' && reserved[kind].has(id)) return { kind, id, name: this.nameOf(kind, id), reason: 'busy', blockId: null };
      if (this.#isBlocked(kind, id, slots)) return { kind, id, name: this.nameOf(kind, id), reason: 'unavailable' };
      const hit = this.#busyAt(kind, id, slots, ignore);
      if (hit) return { kind, id, name: this.nameOf(kind, id), reason: 'busy', blockId: hit.b };
      if (kind === 'room' && !this.rooms.has(id)) return { kind, id, message: 'A required room is no longer active.' };
      if (kind === 'teacher') {
        const teacher = this.staff.get(String(id));
        const fail = (message) => ({ kind, id, message });
        if (!teacher) return fail('The assigned teacher is no longer active.');
        const busy = this.busy.teacher.get(String(id));
        const occupied = ignore ? [...(busy ?? [])].filter(([, tag]) => tag.b !== ignore) : busy;
        const max = teacher.maxPeriodsPerWeek;
        if (Number.isInteger(max) && (occupied?.size ?? occupied?.length ?? 0) + slots.length > max) {
          return fail(teacher.name + ' would exceed the weekly limit of ' + max + ' teaching periods.');
        }
        // Rebuilding an already-saved draft (fromEntries) must not drop a lesson just because a critical rule
        // got stricter since it was placed: that is reported separately by criticalViolations(), not here.
        if (!relaxCritical) {
          const free = this.#weight('teacherMinFreePerDay', 'teacher', id);
          const daily = this.#weight('teacherMaxPerDay', 'teacher', id);
          let used = slots.length;
          if (free.w === CRITICAL || daily.w === CRITICAL) {
            for (const [key] of occupied ?? []) if (Math.floor(key / 100) === day) used += 1;
          }
          if (daily.w === CRITICAL && used > daily.value) {
            return fail(teacher.name + ' would exceed the daily limit of ' + daily.value + ' teaching periods on ' + DAY_NAMES[day] + '.');
          }
          if (free.w === CRITICAL) {
            const available = this.#availableTeachingSlots(id, day);
            if (used > Math.max(0, available - free.value)) {
              return fail(teacher.name + ' needs ' + free.value + ' available free period(s) on ' + DAY_NAMES[day] + '.');
            }
          }
        }
      }
      return null;
    };

    for (const unit of block.units) {
      for (const sid of unit.sectionIds) {
        const b = need('section', sid);
        if (b) blockers.push(b);
        else reserved.section.add(sid);
      }

      const pref = preferred?.[unit.key];
      const teacherIds = [];
      if (pref) {
        const stored = pref.teacherIds || [];
        const permitted = stored.every((id) => unit.teacherIds.includes(id)) && new Set(stored).size === stored.length;
        const expected = unit.mode === 'one_of' && unit.teacherIds.length ? 1 : unit.teacherIds.length;
        if (!permitted || stored.length !== expected) {
          blockers.push({ kind: 'teacher', message: unit.subjectName + ': the teacher assignment changed in the teaching plan.' });
        }
        for (const tid of stored) {
          const b = need('teacher', tid);
          if (b) blockers.push(b);
          else { reserved.teacher.add(tid); teacherIds.push(tid); }
        }
      } else if (unit.teacherIds.length) {
        if (unit.mode === 'together' || unit.teacherIds.length === 1) {
          for (const tid of unit.teacherIds) {
            const b = need('teacher', tid);
            if (b) blockers.push(b);
            else { reserved.teacher.add(tid); teacherIds.push(tid); }
          }
        } else {
          const options = [];
          const failures = [];
          for (const tid of unit.teacherIds) {
            const b = need('teacher', tid);
            if (b) failures.push(b);
            else options.push(tid);
          }
          if (options.length) {
            options.sort((a, b) => this.#load('teacher', a) - this.#load('teacher', b) || a.localeCompare(b));
            reserved.teacher.add(options[0]);
            teacherIds.push(options[0]);
          } else {
            blockers.push({
              kind: 'teacher',
              id: unit.teacherIds.join(','),
              name: unit.teacherIds.map((t) => this.nameOf('teacher', t)).join(' or '),
              reason: 'none_free',
              message: failures.some((failure) => failure.message) ? failures.map((failure) => this.#describe(failure)).join(' ') : undefined,
              blockId: failures.length === 1 ? failures[0].blockId ?? null : null, 
            });
          }
        }
      }

      const roomIds = [];
      const { required, pool } = this.#roomCandidates(unit);
      if (needsRoomChoice(unit.room)) {
        blockers.push({ kind: 'room', message: unit.subjectName + ': choose which rooms it may use.' });
      } else if (pref) {
        const stored = pref.roomIds || [];
        const valid = pool.length || ['any', 'oneOf'].includes(unit.room?.type)
          ? stored.length === 1 && pool.includes(stored[0])
          : stored.length === required.length && required.every((id) => stored.includes(id) && this.rooms.has(id));
        if (!valid) blockers.push({ kind: 'room', message: unit.subjectName + ': the room requirement changed in the teaching plan.' });
        for (const rid of stored) {
          const b = need('room', rid);
          if (b) blockers.push(b);
          else { reserved.room.add(rid); roomIds.push(rid); }
        }
      } else {
        for (const rid of required) {
          const b = need('room', rid);
          if (b) blockers.push(b);
          else { reserved.room.add(rid); roomIds.push(rid); }
        }
        if (unit.room?.type === 'oneOf' || unit.room?.type === 'any') {
          const free = pool.filter((rid) => !need('room', rid));
          if (free.length) {
            free.sort((a, b) => this.#load('room', a) - this.#load('room', b) || a.localeCompare(b));
            reserved.room.add(free[0]);
            roomIds.push(free[0]);
          } else {
            blockers.push({ kind: 'room', id: pool.join(','), name: pool.length ? 'a suitable room' : 'any room', reason: 'none_free' });
          }
        }
      }
      assign.push({ unitKey: unit.key, teacherIds, roomIds });
    }
    return { ok: blockers.length === 0, blockers, assign };
  }

  // ------------------------------------------------------- apply / remove

  apply(block, day, first, assign, locked = false) {
    for (let i = 0; i < block.units.length; i += 1) {
      const unit = block.units[i];
      const a = assign[i];
      const tag = { b: block.id, subj: unit.spreadKey, unit: unit.key };
      for (let k = 0; k < block.length; k += 1) {
        const s = slot(day, first + k);
        for (const sid of unit.sectionIds) this.#set('section', sid, s, tag);
        for (const tid of a.teacherIds) this.#set('teacher', tid, s, tag);
        for (const rid of a.roomIds) this.#set('room', rid, s, tag);
      }
    }
    this.placements.set(block.id, { block, day, first, assign, locked });
  }

  #set(kind, id, s, tag) {
    let map = this.busy[kind].get(String(id));
    if (!map) { map = new Map(); this.busy[kind].set(String(id), map); }
    map.set(s, tag);
  }

  remove(blockId) {
    const p = this.placements.get(blockId);
    if (!p) return null;
    for (let i = 0; i < p.block.units.length; i += 1) {
      const unit = p.block.units[i];
      const a = p.assign[i];
      for (let k = 0; k < p.block.length; k += 1) {
        const s = slot(p.day, p.first + k);
        for (const sid of unit.sectionIds) this.busy.section.get(String(sid))?.delete(s);
        for (const tid of a.teacherIds) this.busy.teacher.get(String(tid))?.delete(s);
        for (const rid of a.roomIds) this.busy.room.get(String(rid))?.delete(s);
      }
    }
    this.placements.delete(blockId);
    return p;
  }

  // ------------------------------------------------------------- penalties

  /** >1 only while compact() runs: an empty period for a class outranks a teacher's free period. */
  #emptyScale = 1;

  #weight(key, scope, id) {
    const override = scope === 'teacher' ? this.rules.teachers[id]?.[key] : scope === 'section' ? this.rules.sections[id]?.[key] : undefined;
    const rule = override ?? this.rules.defaults[key];
    if (!rule || rule.level === 'off' || rule.value === false || rule.value === null || rule.value === undefined) return { w: 0, value: 0 };
    let w = WEIGHT[rule.level] ?? 0;
    if (this.#emptyScale > 1 && scope === 'section' && w < CRITICAL && (key === 'classNoGaps' || key === 'classStartsPeriod1')) w *= this.#emptyScale;
    return { w, value: rule.value };
  }

  #byDay(map) {
    const days = new Map();
    for (const [s, tag] of map) {
      const day = Math.floor(s / 100);
      const entry = days.get(day) || { nos: [], subjects: new Map() };
      entry.nos.push(s % 100);
      const units = entry.subjects.get(tag.subj) || new Set();
      units.add(tag.unit);
      entry.subjects.set(tag.subj, units);
      days.set(day, entry);
    }
    for (const entry of days.values()) entry.nos.sort((a, b) => a - b);
    return days;
  }

  sectionPenalty(sid, report?) {
    const map = this.busy.section.get(String(sid));
    if (!map || map.size === 0) return 0;
    const gaps = this.#weight('classNoGaps', 'section', sid);
    const starts = this.#weight('classStartsPeriod1', 'section', sid);
    const spread = this.#weight('subjectSpread', 'section', sid);
    const balance = this.#weight('dayBalance', 'section', sid);
    const byDay = this.#byDay(map);
    let total = 0;
    let periods = 0;
    for (const [day, entry] of byDay) {
      const { nos } = entry;
      periods += nos.length;
      const min = nos[0];
      const max = nos[nos.length - 1];
      const gapCount = max - min + 1 - nos.length;
      report?.(gaps, gapCount, 'classNoGaps', sid, null, day);
      report?.(starts, min - 1, 'classStartsPeriod1', sid, null, day);
      total += gaps.w * gapCount;
      total += starts.w * (min - 1);
      for (const [subj, set] of entry.subjects) {
        const configured = this.rules.sections[sid]?.subjectSpread ?? this.problem.rules?.defaults?.subjectSpread;
        const cap = configured?.level === 'critical' ? Number(spread.value) || 1
          : Math.max(Number(spread.value) || 1, this.subjectCap.get(`${sid}|${subj}`) || 1);
        if (set.size > cap) {
          report?.({ ...spread, value: cap }, set.size - cap, 'subjectSpread', sid, subj, day);
          total += spread.w * (set.size - cap);
        }
      }
    }
    if (balance.w && this.days.length > 1) {
      const avg = periods / this.days.length;
      let deviation = 0;
      for (const day of this.days) deviation += Math.abs((byDay.get(day)?.nos.length || 0) - avg);
      report?.(balance, Math.round(deviation), 'dayBalance', sid);
      total += balance.w * Math.round(deviation);
    }
    return total;
  }

  teacherPenalty(tid, report?) {
    const map = this.busy.teacher.get(String(tid));
    if (!map || map.size === 0) return 0;
    const perDay = this.#weight('teacherMaxPerDay', 'teacher', tid);
    const inRow = this.#weight('teacherMaxInRow', 'teacher', tid);
    const gaps = this.#weight('teacherNoGaps', 'teacher', tid);
    const free = this.#weight('teacherMinFreePerDay', 'teacher', tid);
    const longDays = this.#weight('teacherLongDays', 'teacher', tid);
    // Long days only soften a daily maximum that can be exceeded; a Critical maximum stays exact.
    const longActive = Boolean(perDay.w && perDay.w < CRITICAL && longDays.w);
    let longCount = 0;
    let total = 0;
    for (const [day, entry] of this.#byDay(map)) {
      const { nos } = entry;
      if (free.w) {
        const deficit = Math.max(0, nos.length - Math.max(0, this.#availableTeachingSlots(tid, day) - free.value));
        total += free.w * deficit;
        report?.(free, deficit, 'teacherMinFreePerDay', tid, null, day);
      }
      if (perDay.w && nos.length > perDay.value) {
        // With long days, the first extra period is the long day itself and only the rest counts as overload.
        const over = nos.length - perDay.value - (longActive ? 1 : 0);
        if (longActive) longCount += 1;
        if (over > 0) {
          report?.(perDay, over, 'teacherMaxPerDay', tid, null, day);
          total += perDay.w * over;
        }
      }
      if (gaps.w) {
        const gapCount = nos[nos.length - 1] - nos[0] + 1 - nos.length;
        report?.(gaps, gapCount, 'teacherNoGaps', tid, null, day);
        total += gaps.w * gapCount;
      }
      if (inRow.w) {
        const periods = this.periodsByDay.get(day) || [];
        let run = 1;
        for (let i = 1; i <= nos.length; i += 1) {
          const joined = i < nos.length && nos[i] === nos[i - 1] + 1 && periods[nos[i - 1] - 1]?.joinsNext;
          if (joined) run += 1;
          else {
            if (run > inRow.value) {
              report?.(inRow, run - inRow.value, 'teacherMaxInRow', tid, null, day);
              total += inRow.w * (run - inRow.value);
            }
            run = 1;
          }
        }
      }
    }
    if (longActive && longCount > longDays.value) {
      report?.(longDays, longCount - longDays.value, 'teacherLongDays', tid);
      total += longDays.w * (longCount - longDays.value);
    }
    return total;
  }

  totalPenalty() {
    let total = 0;
    for (const id of this.sections.keys()) total += this.sectionPenalty(id);
    for (const id of this.staff.keys()) total += this.teacherPenalty(id);
    return total;
  }

  #affected(blocks) {
    return {
      sections: new Set(blocks.flatMap((block) => block.sectionIds)),
      teachers: new Set(blocks.flatMap((block) => block.units.flatMap((unit) => unit.teacherIds))),
    };
  }

  criticalViolations({ sections = this.sections.keys(), teachers = this.staff.keys() } = {}) {
    const violations = new Map();
    const report = (rule, count, key, id, subject, day) => {
      if (rule.w !== CRITICAL || count <= 0) return;
      const token = JSON.stringify([key, id, subject, day]);
      const prior = violations.get(token)?.count || 0;
      violations.set(token, { count: count + prior, key, id, subject, day, limit: rule.value });
    };
    for (const id of sections) this.sectionPenalty(id, report);
    for (const id of teachers) this.teacherPenalty(id, report);
    return violations;
  }

  #newViolations(before, scope) {
    return [...this.criticalViolations(scope)]
      .filter(([key, violation]) => violation.count > (before.get(key)?.count ?? 0))
      .map(([, violation]) => violation);
  }

  describeCritical({ key, id, subject, day, limit }) {
    const name = this.nameOf(key.startsWith('teacher') ? 'teacher' : 'section', id);
    let subjectName;
    if (subject) {
      for (const block of this.blocks.values()) {
        subjectName = block.units.find((unit) => unit.spreadKey === subject)?.subjectName;
        if (subjectName) break;
      }
    }
    const phrasing = {
      classNoGaps: 'cannot have gaps between lessons',
      classStartsPeriod1: 'must start in period 1',
      dayBalance: 'must keep an even load across the week',
      teacherNoGaps: 'cannot have gaps between lessons',
      teacherMaxPerDay: 'can teach at most ' + limit + ' periods per day',
      teacherLongDays: 'can have at most ' + limit + ' long day' + (limit === 1 ? '' : 's') + ' a week',
      teacherMinFreePerDay: 'needs at least ' + limit + ' available free period(s)',
      teacherMaxInRow: 'can teach at most ' + limit + ' periods in a row',
      subjectSpread: 'can have at most ' + limit + ' ' + (subjectName || 'same-subject') + ' lesson' + (limit === 1 ? '' : 's') + ' per day',
    };
    return name + ' ' + phrasing[key] + (day ? ' (' + DAY_NAMES[day] + ')' : '') + '.';
  }

  /** Score a candidate and enforce each Critical rule independently. */
  #evaluatePlacement(block, day, first, assign, beforeCritical) {
    const scope = this.#affected([block]);
    const before = this.#localPenalty([block]);
    const baseline = beforeCritical ?? this.criticalViolations(scope);
    this.apply(block, day, first, assign, false);
    try {
      return { delta: this.#localPenalty([block]) - before, violations: this.#newViolations(baseline, scope) };
    } finally {
      this.remove(block.id);
    }
  }

  deltaFor(block, day, first, assign, baseline) {
    const result = this.#evaluatePlacement(block, day, first, assign, baseline);
    return result.violations.length ? Infinity : result.delta;
  }

  #criticalReasons(block, day, first, assign, baseline) {
    return this.#evaluatePlacement(block, day, first, assign, baseline).violations.map((item) => this.describeCritical(item));
  }

  bestPosition(block, { exclude = null, baseline = this.criticalViolations(this.#affected([block])) } = {}) {
    let best = null;
    for (const day of this.days) {
      const count = this.periodsByDay.get(day).length;
      for (let first = 1; first + block.length - 1 <= count; first += 1) {
        if (exclude && exclude.day === day && exclude.first === first) continue;
        const r = this.resolve(block, day, first);
        if (!r.ok) continue;
        const delta = this.deltaFor(block, day, first, r.assign, baseline);
        if (delta >= HARD) continue;
        const score = delta + this.rng() * 0.5;
        if (!best || score < best.score) best = { day, first, assign: r.assign, delta, score };
      }
    }
    return best;
  }

  #restore(p) {
    this.apply(p.block, p.day, p.first, p.assign, p.locked);
  }

  #tryEject(block) {
    const candidates = [];
    for (const day of this.days) {
      const count = this.periodsByDay.get(day).length;
      for (let first = 1; first + block.length - 1 <= count; first += 1) {
        const r = this.resolve(block, day, first);
        if (r.ok) continue;
        if (r.blockers.some((b) => !b.blockId)) continue;
        const ids = [...new Set(r.blockers.map((b) => b.blockId))];
        if (ids.length !== 1) continue;
        const victim = this.placements.get(ids[0]);
        if (!victim || victim.locked) continue;
        candidates.push({ day, first, victim: ids[0] });
      }
    }
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const c of candidates.slice(0, 40)) {
      const scope = this.#affected([block, this.placements.get(c.victim).block]);
      const baseline = this.criticalViolations(scope);
      const old = this.remove(c.victim);
      const r = this.resolve(block, c.day, c.first);
      if (!r.ok || this.deltaFor(block, c.day, c.first, r.assign) >= HARD) {
        this.#restore(old);
        continue;
      }
      this.apply(block, c.day, c.first, r.assign, false);
      const alt = this.bestPosition(old.block, { exclude: { day: old.day, first: old.first } });
      if (alt) {
        this.apply(old.block, alt.day, alt.first, alt.assign, false);
        if (!this.#newViolations(baseline, scope).length) return true;
        this.remove(old.block.id);
      }
      this.remove(block.id);
      this.#restore(old);
    }
    return false;
  }

  /** Put every pending block in the best conflict-free slot, hardest blocks first. */
  place() {
    const pending = [...this.blocks.values()].filter((b) => !this.placements.has(b.id));
    const teacherLoad = new Map();
    for (const b of pending) for (const u of b.units) for (const t of u.teacherIds) teacherLoad.set(t, (teacherLoad.get(t) || 0) + u.length);
    const weight = (b) => {
      const blockedSlots = b.units.reduce((t, u) => t + u.teacherIds.reduce((n, id) => n + (this.blocked.teacher.get(id)?.size || 0), 0), 0);
      const heaviest = Math.max(0, ...b.units.flatMap((u) => u.teacherIds.map((t) => teacherLoad.get(t) || 0)));
      return b.length * 40 + b.units.length * 25 + b.sectionIds.length * 10 + blockedSlots * 3 + heaviest + this.rng();
    };
    pending.sort((a, b) => weight(b) - weight(a));
    const failed = [];
    for (const block of pending) {
      const best = this.bestPosition(block);
      if (best) this.apply(block, best.day, best.first, best.assign, false);
      else failed.push(block);
    }
    for (const block of failed) {
      if (this.placements.has(block.id)) continue;
      if (this.#tryEject(block)) continue;
      const best = this.bestPosition(block);
      if (best) this.apply(block, best.day, best.first, best.assign, false);
    }
  }

  /** Improve balance and gaps by moving single blocks; stops on budget, iterations or a stop signal. */
  /**
   * Exchange the slots of two unlocked lessons of the same length and keep the exchange only when
   * the timetable is strictly better. A class with no free period cannot take a one-lesson move, so
   * without swaps a fully booked school could never improve once every lesson was placed.
   */
  #trySwap(temperature = 0) {
    const movable = [...this.placements.values()].filter((p) => !p.locked);
    if (movable.length < 2) return false;
    const a = movable[Math.floor(this.rng() * movable.length)];
    const others = movable.filter((p) => p !== a && p.block.length === a.block.length && (p.day !== a.day || p.first !== a.first));
    if (!others.length) return false;
    // Two lessons of one class keep that class full, so prefer them; otherwise any lesson of the same length.
    const sameClass = others.filter((p) => p.block.sectionIds.some((sid) => a.block.sectionIds.includes(sid)));
    const pool = sameClass.length && this.rng() < 0.9 ? sameClass : others;
    const b = pool[Math.floor(this.rng() * pool.length)];
    const before = this.#localPenalty([a.block, b.block]);
    const scope = this.#affected([a.block, b.block]);
    const baseline = this.criticalViolations(scope);
    this.remove(a.block.id);
    this.remove(b.block.id);
    const toB = this.resolve(a.block, b.day, b.first);
    if (toB.ok) {
      this.apply(a.block, b.day, b.first, toB.assign, false);
      const toA = this.resolve(b.block, a.day, a.first);
      if (toA.ok) {
        this.apply(b.block, a.day, a.first, toA.assign, false);
        const delta = this.#localPenalty([a.block, b.block]) - before;
        // A slightly worse swap is sometimes kept early on (never one that breaks a critical rule), so the search can leave a rut.
        if (!this.#newViolations(baseline, scope).length &&
            (delta < -1e-9 || (temperature > 0 && this.rng() < Math.exp(-delta / temperature)))) return true;
        this.remove(b.block.id);
      }
      this.remove(a.block.id);
    }
    this.#restore(b);
    this.#restore(a);
    return false;
  }

  optimize({ budgetMs = 2000, maxIterations = 20000, shouldStop = () => false, onProgress } = {}) {
    const started = Date.now();
    let iterations = 0;
    let moves = 0;
    while (iterations < maxIterations && Date.now() - started < budgetMs && !shouldStop()) {
      iterations += 1;
      if (iterations % 250 === 0) {
        for (const block of this.blocks.values()) {
          if (this.placements.has(block.id)) continue;
          const best = this.bestPosition(block);
          if (best) this.apply(block, best.day, best.first, best.assign, false);
          else this.#tryEject(block);
        }
        onProgress?.({ iterations, moves, penalty: this.totalPenalty() });
      }
      const progress = Math.max((Date.now() - started) / budgetMs, iterations / maxIterations);
      if (this.rng() < 0.5 && this.#trySwap(SWAP_START_TEMPERATURE * Math.max(0, 1 - progress * 1.25))) {
        moves += 1;
        continue;
      }
      const movable = [...this.placements.values()].filter((p) => !p.locked);
      if (!movable.length) break;
      const p = movable[Math.floor(this.rng() * movable.length)];
      const baseline = this.criticalViolations(this.#affected([p.block]));
      const old = this.remove(p.block.id);
      const origin = this.resolve(old.block, old.day, old.first, { preferred: Object.fromEntries(old.assign.map((a) => [a.unitKey, a])) });
      const originDelta = origin.ok ? this.deltaFor(old.block, old.day, old.first, origin.assign) : Infinity;
      const alt = this.bestPosition(old.block, { baseline });
      if (alt && alt.delta < originDelta - 1e-9) {
        this.apply(old.block, alt.day, alt.first, alt.assign, false);
        moves += 1;
      } else {
        this.#restore(old);
      }
    }
    return { iterations, moves, ms: Date.now() - started };
  }

  /**
   * Deterministic tidy-up after the random search: sweep every unlocked lesson, move it to its
   * best slot when that is strictly better, and repeat until a full pass changes nothing.
   * Pulls late starts and mid-day gaps out of the result so they do not depend on luck or on
   * how long the search was allowed to run. Never moves a locked lesson.
   */
  compact({ maxPasses = 6, budgetMs = 1500, shouldStop = () => false } = {}) {
    this.#emptyScale = 4;
    try {
      return this.#compactPasses({ maxPasses, budgetMs, shouldStop });
    } finally {
      this.#emptyScale = 1;
    }
  }

  #compactPasses({ maxPasses, budgetMs, shouldStop }) {
    const started = Date.now();
    let moves = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;
      const order = [...this.placements.values()].filter((p) => !p.locked).map((p) => p.block.id).sort();
      for (const blockId of order) {
        if (Date.now() - started >= budgetMs || shouldStop()) return { moves, ms: Date.now() - started };
        const placed = this.placements.get(blockId);
        if (!placed) continue;
        const baseline = this.criticalViolations(this.#affected([placed.block]));
        const old = this.remove(blockId);
        const origin = this.resolve(old.block, old.day, old.first, { preferred: Object.fromEntries(old.assign.map((a) => [a.unitKey, a])) });
        const originDelta = origin.ok ? this.deltaFor(old.block, old.day, old.first, origin.assign) : Infinity;
        const alt = this.bestPosition(old.block, { baseline });
        if (alt && alt.delta < originDelta - 1e-9) {
          this.apply(old.block, alt.day, alt.first, alt.assign, false);
          moves += 1;
          changed = true;
        } else {
          this.#restore(old);
        }
      }
      if (!changed) {
        // Single moves are stuck: try bumping the one lesson that blocks a better slot.
        const chained = this.#compactByEjection(started + budgetMs, shouldStop);
        moves += chained;
        if (!chained) break;
      }
    }
    return { moves, ms: Date.now() - started };
  }

  /** Empty periods inside a class's day: late starts plus holes between lessons. */
  #emptyCount(sids) {
    let total = 0;
    for (const sid of sids) {
      const map = this.busy.section.get(String(sid));
      if (!map) continue;
      for (const [, entry] of this.#byDay(map)) {
        const { nos } = entry;
        total += nos[0] - 1 + (nos[nos.length - 1] - nos[0] + 1 - nos.length);
      }
    }
    return total;
  }

  #localPenalty(blocks) {
    const sections = new Set();
    const teachers = new Set();
    for (const b of blocks) {
      for (const sid of b.sectionIds) sections.add(sid);
      for (const u of b.units) for (const t of u.teacherIds) teachers.add(t);
    }
    let total = 0;
    for (const sid of sections) total += this.sectionPenalty(sid);
    for (const tid of teachers) total += this.teacherPenalty(tid);
    return total;
  }

  /**
   * Put lesson A into a slot that is only blocked by one other unlocked lesson V, send V to its
   * next-best slot, and keep the exchange only when the timetable is strictly better for it.
   */
  #compactByEjection(deadline, shouldStop) {
    let improved = 0;
    // Only classes that really have a hole or a late start can gain from this expensive pass.
    const troubled = new Set([...this.sections.keys()].filter((sid) => this.#emptyCount([sid]) > 0));
    if (!troubled.size) return 0;
    const ids = [...this.placements.values()]
      .filter((p) => !p.locked && p.block.sectionIds.some((sid) => troubled.has(sid)))
      .map((p) => p.block.id)
      .sort();
    for (const aId of ids) {
      let a = this.placements.get(aId);
      if (!a || a.locked) continue;
      for (const day of this.days) {
        const count = this.periodsByDay.get(day).length;
        for (let first = 1; first + a.block.length - 1 <= count; first += 1) {
          if (Date.now() >= deadline || shouldStop()) return improved;
          a = this.placements.get(aId);
          if (!a || (a.day === day && a.first === first)) continue;
          // Which single lesson stands in the way once A has left its own slot?
          const oldA = this.remove(aId);
          const probe = this.resolve(oldA.block, day, first);
          const blockerIds = [...new Set(probe.blockers.map((b) => b.blockId))];
          const victim = !probe.ok && probe.blockers.every((b) => b.blockId) && blockerIds.length === 1 ? this.placements.get(blockerIds[0]) : null;
          if (!victim || victim.locked || victim.block.id === aId) { this.#restore(oldA); continue; }

          this.#restore(oldA);
          const before = this.#localPenalty([oldA.block, victim.block]);
          const scope = this.#affected([oldA.block, victim.block]);
          const baseline = this.criticalViolations(scope);
          const oldV = this.remove(victim.block.id);
          this.remove(aId);
          const place = this.resolve(oldA.block, day, first);
          let kept = false;
          if (place.ok) {
            this.apply(oldA.block, day, first, place.assign, false);
            const alt = this.bestPosition(oldV.block, { exclude: { day: oldV.day, first: oldV.first } });
            if (alt) {
              this.apply(oldV.block, alt.day, alt.first, alt.assign, false);
              const after = this.#localPenalty([oldA.block, oldV.block]);
              if (after < before - 1e-9 && !this.#newViolations(baseline, scope).length) kept = true;
              else this.remove(oldV.block.id);
            }
            if (!kept) this.remove(aId);
          }
          if (kept) { improved += 1; continue; }
          this.#restore(oldV);
          this.#restore(oldA);
        }
      }
    }
    return improved;
  }

  // ---------------------------------------------------- empty-period report

  /**
   * Periods a class must fill each week and how many it has. Same-time lessons (French / Hindi) and
   * combined lessons share one slot, so each block counts once per class, whatever its unit count.
   */
  sectionLoad(sid) {
    let planned = 0;
    for (const block of this.blocks.values()) if (block.sectionIds.includes(sid)) planned += block.length;
    let capacity = 0;
    for (const day of this.days) {
      for (const p of this.periodsByDay.get(day)) if (!this.blocked.section.get(String(sid))?.has(slot(day, p.no))) capacity += 1;
    }
    return { planned, capacity };
  }

  #lessonLabel(placement) {
    const classes = placement.block.sectionIds.map((id) => this.nameOf('section', id)).join(', ');
    return `${placement.block.subjectName} for ${classes} (${DAY_NAMES[placement.day]} period ${placement.first})`;
  }

  /** The single most useful way to fill one empty period of one class, in plain words. */
  #fillFix(sid, day, period) {
    const options = [];
    for (const placement of [...this.placements.values()]) {
      if (placement.locked || !placement.block.sectionIds.includes(sid)) continue;
      if (placement.day === day && placement.first === period) continue;
      const before = this.#emptyCount(placement.block.sectionIds);
      const old = this.remove(placement.block.id);
      try {
        const r = this.resolve(old.block, day, period);
        if (!r.ok && r.blockers.every((b) => b.kind === 'period' || b.kind === 'day')) continue;
        let critical = [];
        let shifts = false;
        if (r.ok && this.deltaFor(old.block, day, period, r.assign) >= HARD) critical = this.#criticalReasons(old.block, day, period, r.assign);
        else if (r.ok) {
          // It fits, but does the class end up with fewer empty periods, or just a hole somewhere else?
          this.apply(old.block, day, period, r.assign, false);
          shifts = this.#emptyCount(old.block.sectionIds) >= before;
          this.remove(old.block.id);
        }
        options.push({ old, blockers: r.blockers, critical, shifts });
      } finally {
        this.#restore(old);
      }
    }
    if (!options.length) return 'No lesson of this class can reach that slot. Add a lesson for the class or shorten the school day.';
    const cost = (o) => o.blockers.length + o.critical.length + (o.shifts ? 0.75 : 0) + (o.blockers.every((b) => b.blockId) ? 0 : 0.5);
    options.sort((a, b) => cost(a) - cost(b) || a.old.block.id.localeCompare(b.old.block.id));
    const best = options[0];
    const target = `${DAY_NAMES[day]} period ${period}`;
    const lesson = `${best.old.block.subjectName} (now ${DAY_NAMES[best.old.day]} period ${best.old.first})`;
    if (!best.blockers.length && !best.critical.length && best.shifts) {
      return `Move ${lesson} into ${target}, then close the hole it leaves on ${DAY_NAMES[best.old.day]} by moving that day's next lesson up one period.`;
    }
    if (!best.blockers.length && !best.critical.length) return `Move ${lesson} into ${target}. It fits, so drag it there in the editor.`;
    const steps = best.blockers.map((b) => {
      const victim = b.blockId ? this.placements.get(b.blockId) : null;
      if (b.reason === 'unavailable') return `make ${b.name} available in ${target} (Rooms & availability step)`;
      if (b.reason === 'none_free') return b.kind === 'room' ? `free up a room in ${target}, or add a room` : `free ${b.name} in ${target}`;
      if (victim) return `move ${victim.block.subjectName} for ${victim.block.sectionIds.map((id) => this.nameOf('section', id)).join(', ')} out of ${target}${b.kind === 'teacher' ? ` (${b.name} teaches it)` : b.kind === 'room' ? ` (it uses ${b.name})` : ''}`;
      return `free ${b.name} in ${target}`;
    });
    for (const message of best.critical) steps.push(`relax this rule: ${message.replace(/\.$/, '')}`);
    return `Move ${lesson} into ${target}. First ${steps.join(', and ')}.`;
  }

  /**
   * Every empty period a class would notice — a hole between lessons, a late start, free periods the
   * plan never fills, a class with no lessons — each with the exact change that would fix it.
   */
  emptyPeriods() {
    const gaps = [];
    const plan = [];
    for (const sid of this.sections.keys()) {
      const name = this.nameOf('section', sid);
      const map = this.busy.section.get(String(sid));
      const { planned, capacity } = this.sectionLoad(sid);
      if (planned === 0) {
        plan.push({ kind: 'blank', sectionId: sid, section: name, day: null, period: null, count: capacity, message: `${name} has no lessons planned, so its whole timetable is empty.`, fix: `Add ${name}'s lessons in the Teaching plan step, then generate again.` });
        continue;
      }
      for (const day of this.days) {
        const nos = [...(map?.keys() || [])].filter((s) => Math.floor(s / 100) === day).map((s) => s % 100).sort((a, b) => a - b);
        if (!nos.length) continue;
        const open = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((n) => !this.blocked.section.get(String(sid))?.has(slot(day, n)));
        const runs = [];
        if (nos[0] > 1) runs.push({ kind: 'late_start', list: open(1, nos[0] - 1), note: `lessons start in period ${nos[0]}` });
        for (let i = 0; i + 1 < nos.length; i += 1) if (nos[i + 1] - nos[i] > 1) runs.push({ kind: 'gap', list: open(nos[i] + 1, nos[i + 1] - 1), note: 'between lessons' });
        for (const run of runs) {
          if (!run.list.length) continue;
          const text = run.list.length === 1 ? `period ${run.list[0]}` : `periods ${run.list[0]}–${run.list[run.list.length - 1]}`;
          gaps.push({
            kind: run.kind, sectionId: sid, section: name, day, period: run.list[0], count: run.list.length,
            message: `${name} has an empty ${text} on ${DAY_NAMES[day]} (${run.note}).`,
            fix: this.#fillFix(sid, day, run.list[0]),
          });
        }
      }
      if (planned < capacity) {
        const free = capacity - planned;
        plan.push({
          kind: 'unfilled', sectionId: sid, section: name, day: null, period: null, count: free,
          message: `${name} has ${planned} of ${capacity} periods planned, so ${free} period${free === 1 ? '' : 's'} a week stay empty.`,
          fix: `Add ${free} more period${free === 1 ? '' : 's'} to ${name}'s teaching plan (for example Library, Study or Games), or shorten the bell schedule.`,
        });
      }
    }
    return [...gaps, ...plan];
  }

  // ----------------------------------------------------------- inspection

  #describe(b) {
    if (b.message) return b.message;
    const who = b.name || b.id;
    if (b.kind === 'day') return 'That day is not a teaching day.';
    if (b.kind === 'period') return b.reason === 'break' ? 'A multi-period lesson cannot run across a break.' : 'The lesson does not fit in the remaining periods of that day.';
    if (b.reason === 'unavailable') return `${who} is not available then.`;
    if (b.reason === 'none_free') return `${b.kind === 'room' ? 'No suitable room is free' : `None of ${who} is free`} then.`;
    if (b.kind === 'section') return `${who} already has a lesson then.`;
    if (b.kind === 'room') return `${who} is already in use then.`;
    return `${who} is already teaching then.`;
  }

  /** Can this placed block move to (day, first)? Never changes the schedule. */
  checkMove(blockId, day, first) {
    const p = this.placements.get(blockId);
    if (!p) return { ok: false, blockers: [{ kind: 'block', message: 'That lesson is not on the timetable.' }] };
    if (p.locked) return { ok: false, blockers: [{ kind: 'block', message: 'This lesson is locked. Unlock it to move it.' }] };
    const baseline = this.criticalViolations(this.#affected([p.block]));
    this.remove(blockId);
    const r = this.resolve(p.block, day, first);
    let softDelta = null;
    let critical = false;
    if (r.ok) {
      softDelta = this.deltaFor(p.block, day, first, r.assign, baseline);
      critical = !Number.isFinite(softDelta);
    }
    const blockers = r.blockers.map((b) => ({ kind: b.kind, id: b.id, message: this.#describe(b) }));
    if (critical) blockers.push(...this.#criticalReasons(p.block, day, first, r.assign, baseline).map((message) => ({ kind: 'rule', message })));
    this.#restore(p);
    return { ok: r.ok && !critical, blockers, softDelta: softDelta !== null && softDelta < HARD ? softDelta : null };
  }

  /** Every start position for one lesson, so the editor can shade the grid while a lesson is picked up. */
  fitMap(blockId) {
    const p = this.placements.get(blockId);
    const block = p?.block ?? this.blocks.get(blockId);
    if (!block || p?.locked) return [];
    const baseline = this.criticalViolations(this.#affected([block]));
    if (p) this.remove(blockId);
    const out = [];
    for (const day of this.days) {
      const count = this.periodsByDay.get(day).length;
      for (let first = 1; first <= count; first += 1) {
        const r = this.resolve(block, day, first);
        let ok = r.ok;
        let softDelta = null;
        if (ok) {
          softDelta = this.deltaFor(block, day, first, r.assign, baseline);
          if (softDelta >= HARD) { ok = false; softDelta = null; }
        }
        const reasons = ok ? [] : r.ok
          ? this.#criticalReasons(block, day, first, r.assign, baseline)
          : r.blockers.map((blocker) => this.#describe(blocker));
        out.push({ day, first, ok, softDelta, reason: reasons[0] ?? null, reasons: [...new Set(reasons)] });
      }
    }
    if (p) this.#restore(p);
    return out;
  }

  move(blockId, day, first) {
    const check = this.checkMove(blockId, day, first);
    if (!check.ok) return check;
    const p = this.remove(blockId);
    const r = this.resolve(p.block, day, first);
    this.apply(p.block, day, first, r.assign, p.locked);
    return { ...check, ok: true };
  }

  placeAt(blockId, day, first) {
    const block = this.blocks.get(blockId);
    if (!block) return { ok: false, blockers: [{ kind: 'block', message: 'That lesson does not exist.' }] };
    if (this.placements.has(blockId)) return this.move(blockId, day, first);
    const r = this.resolve(block, day, first);
    if (!r.ok) return { ok: false, blockers: r.blockers.map((b) => ({ kind: b.kind, id: b.id, message: this.#describe(b) })) };
    const delta = this.deltaFor(block, day, first, r.assign);
    if (delta >= HARD) {
      return { ok: false, blockers: this.#criticalReasons(block, day, first, r.assign).map((message) => ({ kind: 'rule', message })) };
    }
    this.apply(block, day, first, r.assign, false);
    return { ok: true, blockers: [], softDelta: delta };
  }

  unschedule(blockId) {
    const p = this.placements.get(blockId);
    if (!p) return false;
    if (p.locked) return false;
    this.remove(blockId);
    return true;
  }

  setLocked(blockId, locked) {
    const p = this.placements.get(blockId);
    if (!p) return false;
    p.locked = Boolean(locked);
    return true;
  }

  /** Why a lesson could not be placed — named, counted, most common first. */
  diagnose(block) {
    const counts = new Map();
    let positions = 0;
    let structural = 0;
    let ruleOnly = 0;
    let available = 0;
    for (const day of this.days) {
      const count = this.periodsByDay.get(day).length;
      for (let first = 1; first <= count; first += 1) {
        positions += 1;
        const r = this.resolve(block, day, first);
        if (r.ok) {
          // Free for everyone involved: it only counts against the lesson when a critical rule forbids it.
          if (this.deltaFor(block, day, first, r.assign) >= HARD) ruleOnly += 1;
          else available += 1;
          continue;
        }
        const real = r.blockers.filter((b) => b.kind !== 'period' && b.kind !== 'day');
        if (!real.length) { structural += 1; continue; }
        for (const b of real) {
          const key = JSON.stringify([b.kind, b.id, b.reason, b.message]);
          const entry = counts.get(key) || { b, n: 0 };
          entry.n += 1;
          counts.set(key, entry);
        }
      }
    }
    if (available > 0) return [FREE_SLOT_REASON];
    const reasons = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map(({ b, n }) => b.message ? `${b.message} (${n} of ${positions} possible slots)`
        : `${this.#describe(b).replace(/ then\.$/, '')} in ${n} of ${positions} possible slots.`);
    if (ruleOnly > 0) reasons.push('Free slots exist, but using them would break a critical rule such as a subject twice in one day. Relax that rule or add free periods.');
    if (!reasons.length && structural === positions) reasons.push(`A ${block.length}-period lesson does not fit between the breaks.`);
    if (!reasons.length) reasons.push('No free slot is left.');
    return reasons;
  }

  // -------------------------------------------------------------- results

  entries() {
    const out = [];
    for (const p of this.placements.values()) {
      p.block.units.forEach((unit, i) => {
        const a = p.assign[i];
        for (const sid of unit.sectionIds) {
          out.push({
            id: `${unit.key}|${sid}`,
            blockId: p.block.id,
            unitKey: unit.key,
            lessonId: unit.lessonId,
            partId: unit.partId,
            label: unit.label,
            sectionId: sid,
            subjectId: unit.subjectId,
            subjectName: unit.subjectName,
            teacherIds: a.teacherIds,
            roomIds: a.roomIds,
            day: p.day,
            startNo: p.first,
            length: p.block.length,
            locked: p.locked,
          });
        }
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  unplaced() {
    const out = [];
    for (const block of this.blocks.values()) {
      if (this.placements.has(block.id)) continue;
      const reasons = this.diagnose(block);
      out.push({
        blockId: block.id,
        lessonId: block.units[0].lessonId,
        partId: block.units[0].partId,
        sectionIds: block.sectionIds,
        subjectName: block.subjectName,
        length: block.length,
        teacherIds: [...new Set(block.units.flatMap((u) => u.teacherIds))],
        reasons,
        // A free slot exists, so this is information (not placed yet), not a problem to fix.
        placeable: reasons[0] === FREE_SLOT_REASON,
      });
    }
    return out;
  }

  stats() {
    let totalPeriods = 0;
    let placedPeriods = 0;
    for (const block of this.blocks.values()) {
      const periods = block.length * block.sectionIds.length * block.units.length;
      totalPeriods += periods;
      if (this.placements.has(block.id)) placedPeriods += periods;
    }
    return {
      blocks: this.blocks.size,
      placedBlocks: this.placements.size,
      totalPeriods,
      placedPeriods,
      penalty: this.totalPenalty(),
    };
  }

  /** Spread of each lesson over the week, with the ideal alongside — the "Insights" report. */
  insights() {
    const rows = [];
    const groups = new Map();
    for (const p of this.placements.values()) {
      for (const unit of p.block.units) {
        for (const sid of unit.sectionIds) {
          const key = `${sid}|${unit.spreadKey}`;
          const g = groups.get(key) || { sectionId: sid, subjectName: unit.subjectName, perDay: new Map(), units: 0, length: unit.length, teachers: new Set() };
          g.perDay.set(p.day, (g.perDay.get(p.day) || 0) + 1);
          g.units += 1;
          for (const t of p.assign[p.block.units.indexOf(unit)].teacherIds) g.teachers.add(t);
          groups.set(key, g);
        }
      }
    }
    for (const g of groups.values()) {
      const days = this.days.length;
      const cap = Math.ceil(g.units / Math.max(1, days));
      const actual = this.days.map((d) => g.perDay.get(d) || 0);
      const max = Math.max(...actual);
      const idle = actual.filter((n) => n === 0).length;
      const poor = max > cap || (g.units >= days && idle > 0);
      const ideal = Array.from({ length: days }, (_, i) => Math.floor(g.units / days) + (i < g.units % days ? 1 : 0)).join(', ');
      rows.push({
        sectionId: g.sectionId,
        section: this.nameOf('section', g.sectionId),
        subjectName: g.subjectName,
        teachers: [...g.teachers].map((t) => this.nameOf('teacher', t)),
        units: g.units,
        unitLength: g.length,
        actual,
        ideal,
        poor,
        issue: poor ? 'Uneven distribution of lessons across the available days.' : null,
      });
    }
    rows.sort((a, b) => Number(b.poor) - Number(a.poor) || a.section.localeCompare(b.section));
    return {
      perfect: rows.filter((r) => !r.poor).length,
      poor: rows.filter((r) => r.poor).length,
      total: rows.length,
      days: this.days,
      rows,
    };
  }

  /** Periods taught per teacher per day plus the teacher's total — the "Teacher Workload" report. */
  workload() {
    const rows = [];
    for (const [id, staff] of this.staff) {
      const map = this.busy.teacher.get(id);
      const perDay = this.days.map((d) => {
        let n = 0;
        if (map) for (const s of map.keys()) if (Math.floor(s / 100) === d) n += 1;
        return n;
      });
      const total = perDay.reduce((a, b) => a + b, 0);
      if (!total && !(this.problem.lessons || []).some((l) => (l.parts || []).some((pt) => (pt.teacherIds || []).map(String).includes(id)))) continue;
      rows.push({ teacherId: id, name: staff.name, perDay, total, max: Math.max(0, ...perDay) });
    }
    return rows.sort((a, b) => b.total - a.total);
  }

  /** Rebuild a schedule from stored entries; entries that no longer fit are dropped and reported. */
  static fromEntries(
    problem: Problem,
    entries: ScheduleEntry[],
    { seed = 1, only = null }: { seed?: number; only?: ((entry: ScheduleEntry) => boolean) | null } = {},
  ): Schedule {
    const schedule = new Schedule(problem, { seed });
    const dropped = [];
    const groups = new Map();
    for (const e of entries || []) {
      if (only && !only(e)) continue;
      const list = groups.get(e.blockId) || [];
      list.push(e);
      groups.set(e.blockId, list);
    }
    for (const [blockId, list] of groups) {
      const block = schedule.blocks.get(blockId);
      const head = list[0];
      if (!block) { dropped.push({ blockId, reason: 'The lesson was removed from the plan.' }); continue; }
      const preferred = {};
      for (const e of list) preferred[e.unitKey] = { teacherIds: e.teacherIds || [], roomIds: e.roomIds || [] };
      const assignKeys = block.units.map((u) => u.key);
      if (assignKeys.some((k) => !preferred[k])) { dropped.push({ blockId, reason: 'The lesson changed in the plan.' }); continue; }
      const r = schedule.resolve(block, head.day, head.startNo, { preferred, relaxCritical: true });
      if (!r.ok) { dropped.push({ blockId, reason: r.blockers.map((b) => schedule.#describe(b)).join(' ') }); continue; }
      schedule.apply(block, head.day, head.startNo, r.assign, Boolean(head.locked));
    }
    schedule.dropped = dropped;
    return schedule;
  }
}

/** Generate a timetable. Lessons in `lockedEntries` stay exactly where they are. */
export function generate(
  problem: Problem,
  { seed = 1, budgetMs = 2000, maxIterations = 20000, lockedEntries = [], shouldStop, onProgress }: GenerateOptions = {},
): GenerateOutput & { schedule: Schedule } {
  const started = Date.now();
  const schedule = Schedule.fromEntries(problem, lockedEntries, { seed, only: (e) => e.locked });
  schedule.place();
  const stage = schedule.optimize({ budgetMs, maxIterations, shouldStop, onProgress });
  const tidy = schedule.compact({ shouldStop });
  return {
    schedule,
    entries: schedule.entries(),
    unplaced: schedule.unplaced(),
    stats: { ...schedule.stats(), ...stage, moves: stage.moves + tidy.moves, ms: Date.now() - started },
    warnings: [...schedule.warnings, ...(schedule.dropped || []).map((d) => `A locked lesson was dropped: ${d.reason}`)],
  };
}

/** Pre-flight: what would stop, or weaken, a generation. */
/** Periods a week each teacher is planned for. Shared lessons count once; "one of them" lessons count for nobody in particular. */
function teacherDemandOf(schedule) {
  const demand = new Map();
  for (const block of schedule.blocks.values()) {
    for (const u of block.units) {
      if (!u.teacherIds.length) continue;
      if (u.mode === 'together' || u.teacherIds.length === 1) for (const t of u.teacherIds) demand.set(t, (demand.get(t) || 0) + u.length);
    }
  }
  return demand;
}

export function teacherLoads(problem: Problem): Map<string, number> {
  return teacherDemandOf(new Schedule(problem));
}

/** Periods a week each subject must be taught, by subject id (activities without a subject are skipped). */
function subjectDemandOf(schedule) {
  const demand = new Map();
  for (const block of schedule.blocks.values()) {
    for (const u of block.units) {
      if (!u.teacherIds.length || !u.subjectId) continue;
      const entry = demand.get(u.subjectId) || { name: u.subjectName, periods: 0 };
      entry.periods += u.length;
      demand.set(u.subjectId, entry);
    }
  }
  return demand;
}

export function analyze(problem: Problem): Readiness {
  const s = new Schedule(problem);
  const blocking = [];
  const warnings = [...s.warnings.map((message) => ({ code: 'sync', message }))];
  const days = s.days;
  const hasTeachingPeriods = [...s.periodsByDay.values()].some((periods) => periods.length > 0);
  if (!hasTeachingPeriods) blocking.push({ code: 'bell', message: 'Add teaching periods to the bell schedule.' });
  else if ([...s.periodsByDay.values()].some((periods) => periods.length === 0)) {
    blocking.push({ code: 'bell', message: 'Add teaching periods to every selected day, or remove days without classes.' });
  }
  if (!problem.lessons?.length) blocking.push({ code: 'no_lessons', message: 'Add at least one teaching assignment.' });

  const maxRun = (() => {
    let best = 0;
    for (const periods of s.periodsByDay.values()) {
      let run = 1;
      for (let i = 0; i < periods.length; i += 1) {
        best = Math.max(best, run);
        run = periods[i].joinsNext ? run + 1 : 1;
      }
    }
    return best;
  })();

  // Check room feasibility before search using the same availability and capacity rules as placement.
  const roomFailures = new Set();
  for (const block of s.blocks.values()) {
    if (!hasTeachingPeriods || block.length > maxRun || roomFailures.has(block.subjectName) ||
        !block.units.some((unit) => unit.room && unit.room.type !== 'none') ||
        block.units.some((unit) => needsRoomChoice(unit.room))) continue;
    const hasRoomSlot = days.some((day) => s.periodsByDay.get(day).some((period) => {
      const { blockers } = s.resolve(block, day, period.no);
      return !blockers.some((blocker) => blocker.kind === 'room' || blocker.kind === 'period');
    }));
    if (!hasRoomSlot) {
      roomFailures.add(block.subjectName);
      blocking.push({ code: 'room_capacity', message: `${block.subjectName}: no suitable room is available for the full lesson. Check the room requirements and availability.` });
    }
  }

  const sectionDemand = new Map();
  const teacherDemand = teacherDemandOf(s);
  for (const block of s.blocks.values()) {
    if (hasTeachingPeriods && block.length > maxRun) {
      blocking.push({ code: 'length', message: `${block.subjectName}: a ${block.length}-period lesson is longer than any run of periods between breaks.` });
    }
    for (const sid of block.sectionIds) sectionDemand.set(sid, (sectionDemand.get(sid) || 0) + block.length * block.units.length);
  }
  for (const sid of sectionDemand.keys()) {
    // Same-time lessons share one slot, so capacity is judged on slots a class needs, not on lesson units.
    const { planned: demand, capacity: cap } = s.sectionLoad(sid);
    if (hasTeachingPeriods && demand > cap) blocking.push({ code: 'section_capacity', message: `${s.nameOf('section', sid)} needs ${demand} periods a week but only has ${cap} teaching periods.`, sectionId: sid });
    else if (hasTeachingPeriods && demand < cap) {
      const empty = cap - demand;
      warnings.push({
        code: 'section_light',
        message: `${s.nameOf('section', sid)} has ${demand} of ${cap} periods planned, so ${empty} period${empty === 1 ? '' : 's'} a week will stay empty.`,
        sectionId: sid,
      });
    }
  }
  // A class with no lessons at all never reaches the loop above, so it would silently get a blank timetable.
  if (hasTeachingPeriods) {
    for (const sid of s.sections.keys()) {
      if (sectionDemand.has(sid)) continue;
      warnings.push({ code: 'section_empty', message: `${s.nameOf('section', sid)} has no lessons planned, so its timetable will be blank.`, sectionId: sid });
    }
  }
  for (const [tid, demand] of teacherDemand) {
    const cap = s.teacherCapacity(tid);
    if (hasTeachingPeriods && demand > cap) blocking.push({ code: 'teacher_capacity', message: `${s.nameOf('teacher', tid)} is planned for ${demand} periods but is only free for ${cap}.`, teacherId: tid });
    const perDay = s.rules.defaults.teacherMaxPerDay;
    const long = s.rules.defaults.teacherLongDays;
    const longs = perDay?.level !== 'critical' && long?.level !== 'off' ? Math.min(Number(long?.value) || 0, days.length) : 0;
    if (perDay?.level !== 'off' && perDay?.value && demand > perDay.value * days.length + longs) {
      warnings.push({ code: 'teacher_overload', message: `${s.nameOf('teacher', tid)} has ${demand} periods, above ${perDay.value} a day for ${days.length} days${longs ? `, even with ${longs} long day${longs === 1 ? '' : 's'} of ${perDay.value + 1}` : ''}.`, teacherId: tid });
    }
  }

  // Teaching profile: a teacher's weekly maximum blocks, and a subject short of teachers only warns.
  for (const [tid, planned] of teacherDemand) {
    const max = s.staff.get(String(tid))?.maxPeriodsPerWeek;
    if (Number.isInteger(max) && planned > max) {
      const over = planned - max;
      blocking.push({ code: 'teacher_max', message: `${s.nameOf('teacher', tid)} has ${planned} periods a week but a maximum of ${max}. Remove ${over} period${over === 1 ? '' : 's'} in the Teaching plan.`, teacherId: tid });
    }
  }
  for (const [subjectId, need] of subjectDemandOf(s)) {
    const listed = [...s.staff.values()].filter((t) => (t.subjectIds || []).includes(subjectId));
    if (!listed.length || listed.some((t) => !Number.isInteger(t.maxPeriodsPerWeek))) continue;
    const supply = listed.reduce((total, t) => total + t.maxPeriodsPerWeek, 0);
    if (need.periods > supply) {
      const short = need.periods - supply;
      warnings.push({ code: 'subject_shortage', message: `${need.name} needs ${need.periods} periods a week; teachers who can teach it can give ${supply}. You are ${short} short. Add ${need.name} to another teacher's profile or raise a maximum.`, subjectId });
    }
  }

  for (const lesson of problem.lessons || []) {
    const label = lesson.subjectName || lesson.activityName || (lesson.subjectId ? `Subject #${lesson.subjectId}` : 'Lesson');
    if (lesson.subjectMissing) {
      blocking.push({ code: 'bad_subject', message: `${label} is no longer an active subject.`, subjectId: lesson.subjectId });
    }
    if (!(lesson.sectionIds || []).length) blocking.push({ code: 'no_section', message: `${label} has no class.` });
    for (const sid of lesson.sectionIds || []) if (!s.sections.has(String(sid))) blocking.push({ code: 'bad_section', message: `${label} refers to a class that no longer exists.` });
    for (const part of lesson.parts || []) {
      if (!(part.pattern || []).some((p) => Number(p.count) > 0)) blocking.push({ code: 'no_pattern', message: `${label}${part.label ? ` (${part.label})` : ''} has no lessons per week.` });
      if (!(part.teacherIds || []).length) warnings.push({ code: 'no_teacher', message: `${label}${part.label ? ` (${part.label})` : ''} has no teacher yet.` });
      for (const t of part.teacherIds || []) {
        const teacherId = String(t);
        if (s.staff.has(teacherId)) continue;
        const name = problem.inactiveTeacherNames?.[teacherId];
        const message = name ? `${label} refers to ${name}, who is no longer an active teacher.`
          : `${label} refers to a teacher who no longer exists.`;
        blocking.push({ code: 'bad_teacher', message, teacherId });
      }
      const room = part.room || { type: 'none' };
      for (const r of room.roomIds || []) if (!s.rooms.has(String(r))) blocking.push({ code: 'bad_room', message: `${label} refers to a room that no longer exists.` });
      if (needsRoomChoice(room)) blocking.push({ code: 'no_room_choice', message: `${label}: choose which rooms it may use.` });
    }
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    summary: {
      lessons: (problem.lessons || []).length,
      periods: [...sectionDemand.values()].reduce((a, b) => a + b, 0),
      sections: sectionDemand.size,
      teachers: teacherDemand.size,
      days: days.length,
    },
  };
}
