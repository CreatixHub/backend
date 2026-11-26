import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../lib/errors';
import { RULE_LEVELS, type Bell, type BlockedSlot, type LessonPart, type RuleSet } from './engine/engine';

export const DAY_LABELS = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday',
} as const;

const id = (message: string) =>
  z.string({ invalid_type_error: message }).regex(/^\d{1,18}$/, message)
    .refine((value) => !/^0+$/.test(value), message)
    .transform((value) => BigInt(value).toString());

export const plannerIdSchema = id('Invalid id');
export const plannerYearQuerySchema = z.object({ academicYearId: plannerIdSchema.optional() });
const sectionId = id('One of the chosen classes no longer exists.');
const teacherId = id('One of the chosen teachers no longer exists.');
const roomId = id('One of the chosen rooms no longer exists.');
const roomGroupId = id('That room group no longer exists.');
const subjectId = id('That subject no longer exists.');
const text = z.string().trim().optional();
const numberInput = z.union([z.number(), z.string()]).transform(Number);
const unique = <T>(values: T[]): T[] => [...new Set(values)];

// Surface the planner's actionable messages directly in the API error the planner UI displays.
export function parsePlannerInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  throw new HttpError(400, issues[0].message, issues);
}

function invalid(ctx: z.RefinementCtx, message: string, path: (string | number)[]) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  return z.NEVER;
}

const bellPeriod = z.object({
  id: text,
  name: text,
  startsAt: text,
  endsAt: text,
  isBreak: z.boolean().default(false),
});

const bellDayType = z.object({
  id: text,
  name: text,
  days: z.array(numberInput).default([]),
  periods: z.array(bellPeriod).default([]),
});

// The prototype accepts seconds and stores HH:MM. Compare the stored times to catch zero-length
// rows even when the only difference in the submitted times was the seconds.
const clock = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
export const saveBellSchema = z.object({
  weekType: z.literal('weekly').optional(),
  dayTypes: z.array(bellDayType).min(1, 'Add at least one day type with teaching days.').default([]),
}).transform<Bell>((input, ctx) => {
  const usedDays = new Set<number>();
  const usedTypes = new Set<string>();
  const dayTypes: Bell['dayTypes'] = [];
  for (const [i, type] of input.dayTypes.entries()) {
    const path = ['dayTypes', i];
    const name = type.name || `Day type ${i + 1}`;
    const days = unique(type.days).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      .sort((a, b) => a - b);
    if (!days.length) return invalid(ctx, `"${name}" needs at least one teaching day.`, [...path, 'days']);
    for (const day of days) {
      if (usedDays.has(day)) {
        const label = DAY_LABELS[day as keyof typeof DAY_LABELS];
        return invalid(ctx, `${label} is in more than one day type.`, [...path, 'days']);
      }
      usedDays.add(day);
    }

    const typeId = type.id?.toLowerCase() || randomUUID();
    if (usedTypes.has(typeId)) return invalid(ctx, `"${name}" repeats another day type's id.`, [...path, 'id']);
    usedTypes.add(typeId);

    let previousEnd = '';
    const usedPeriods = new Set<string>();
    const periods: Bell['dayTypes'][number]['periods'] = [];
    for (const [n, period] of type.periods.entries()) {
      const label = `"${name}", row ${n + 1}`;
      const rowPath = [...path, 'periods', n];
      if (!clock.test(period.startsAt ?? '') || !clock.test(period.endsAt ?? '')) {
        return invalid(ctx, `${label}: enter start and end times as HH:MM.`, rowPath);
      }
      const startsAt = period.startsAt!.slice(0, 5);
      const endsAt = period.endsAt!.slice(0, 5);
      if (endsAt <= startsAt) return invalid(ctx, `${label}: ends before it starts.`, rowPath);
      if (startsAt < previousEnd) return invalid(ctx, `${label}: overlaps the row above.`, rowPath);
      const periodId = period.id || randomUUID();
      if (usedPeriods.has(periodId)) return invalid(ctx, `${label}: repeats another row's id.`, rowPath);
      usedPeriods.add(periodId);
      previousEnd = endsAt;
      periods.push({
        id: periodId,
        name: period.name || (period.isBreak ? 'Break' : `Period ${n + 1}`),
        startsAt,
        endsAt,
        isBreak: period.isBreak,
      });
    }
    if (!periods.some((period) => !period.isBreak)) {
      return invalid(ctx, `"${name}" needs at least one teaching period.`, [...path, 'periods']);
    }
    dayTypes.push({ id: typeId, name, days, periods });
  }
  return { weekType: 'weekly', dayTypes };
});

const numericRules = new Set([
  'teacherMaxPerDay', 'teacherLongDays', 'teacherMinFreePerDay', 'teacherMaxInRow', 'subjectSpread',
]);
const flagRules = new Set(['teacherNoGaps', 'classNoGaps', 'classStartsPeriod1', 'dayBalance']);
const rawRuleSet = z.record(z.object({ level: z.unknown(), value: z.unknown() }).nullable());

function ruleSet(label: string) {
  return rawRuleSet.transform<RuleSet>((input, ctx) => {
    const output: RuleSet = {};
    for (const [key, rule] of Object.entries(input)) {
      if (!numericRules.has(key) && !flagRules.has(key)) {
        return invalid(ctx, `${label}: "${key}" is not a rule.`, [key]);
      }
      const level = RULE_LEVELS.find((level) => level === rule?.level);
      if (!level) return invalid(ctx, `${label}: "${key}" needs a level (off, low, medium, high or critical).`, [key, 'level']);
      if (numericRules.has(key)) {
        const rawValue = rule?.value;
        const value = typeof rawValue === 'number' || typeof rawValue === 'string' ? Number(rawValue) : NaN;
        if (!Number.isInteger(value) || value < 1 || value > 20) {
          return invalid(ctx, `${label}: "${key}" needs a whole number between 1 and 20.`, [key, 'value']);
        }
        output[key] = { value, level };
      } else {
        output[key] = { value: Boolean(rule?.value), level };
      }
    }
    return output;
  });
}

export const saveRulesSchema = z.object({
  defaults: ruleSet('Rules').default({}),
  teachers: z.record(ruleSet('Teacher rules')).default({}),
  sections: z.record(ruleSet('Class rules')).default({}),
});
export type PlannerRules = z.output<typeof saveRulesSchema>;

export const availabilityKindSchema = z.enum(['staff', 'section', 'room']);
export type AvailabilityKind = z.infer<typeof availabilityKindSchema>;

const blockedSlot = z.object({ day: numberInput, period: numberInput });
export const saveAvailabilitySchema = z.object({
  blocked: z.array(blockedSlot).default([]).transform<BlockedSlot[]>((items) => {
    const valid = new Map<string, BlockedSlot>();
    for (const item of items) {
      const { day, period } = item;
      if (!Number.isInteger(day) || day < 1 || day > 7 || !Number.isInteger(period) || period < 1 || period > 30) continue;
      valid.set(`${day}:${period}`, item);
    }
    return [...valid.values()].sort((a, b) => a.day - b.day || a.period - b.period);
  }),
});

export const saveSectionExcludedSchema = z.object({
  excluded: z.boolean({
    required_error: 'Say whether the class is excluded (true or false).',
    invalid_type_error: 'Say whether the class is excluded (true or false).',
  }),
});
export const createRoomGroupSchema = z.object({
  name: z.string({ required_error: 'Give the room group a name.' }).trim().min(1, 'Give the room group a name.'),
}).strict();
export const saveRoomGroupSchema = z.object({ groupId: roomGroupId.nullable() }).strict();

const pattern = z.object({ count: numberInput, length: numberInput });
const part = z.object({
  id: text,
  label: text,
  pattern: z.array(pattern).default([]),
  teacherIds: z.array(teacherId).default([]).transform(unique),
  mode: z.string().optional(),
  room: z.object({
    type: z.string(),
    roomIds: z.array(roomId).default([]).transform(unique),
    groupId: roomGroupId.nullish(),
  }).optional(),
});

const activityRequired = 'Choose a subject, or name the activity (for example "Library").';
export const saveLessonSchema = z.object({
  id: plannerIdSchema.optional(),
  sectionIds: z.array(sectionId).min(1, 'Choose at least one class.').default([]).transform(unique),
  subjectId: z.union([subjectId, z.literal('')]).nullish(),
  activityName: text.nullable(),
  syncGroup: text.nullable(),
  parts: z.array(part).min(1, 'Add at least one part with lessons per week.').default([]),
}).transform((input, ctx) => {
  const selectedSubject = input.subjectId || null;
  const activityName = selectedSubject ? null : input.activityName || null;
  if (!selectedSubject && !activityName) return invalid(ctx, activityRequired, ['activityName']);

  const parts: LessonPart[] = [];
  const usedIds = new Set<string>();
  for (const [index, current] of input.parts.entries()) {
    const path = ['parts', index];
    const pattern = current.pattern.filter(({ count }) => count > 0);
    if (!pattern.length) {
      return invalid(ctx, `${current.label || `Part ${index + 1}`}: enter how many lessons per week.`, [...path, 'pattern']);
    }
    for (const item of pattern) {
      if (!Number.isInteger(item.count) || item.count > 12) {
        return invalid(ctx, 'Lessons per week must be a whole number up to 12.', [...path, 'pattern']);
      }
      if (!Number.isInteger(item.length) || item.length < 1 || item.length > 4) {
        return invalid(ctx, 'A lesson can be 1 to 4 periods long.', [...path, 'pattern']);
      }
    }
    const id = current.id || randomUUID();
    if (usedIds.has(id)) return invalid(ctx, 'Lesson parts must have distinct ids.', [...path, 'id']);
    usedIds.add(id);

    const type = current.room?.type;
    const room: LessonPart['room'] = type === 'fixed' || type === 'oneOf' || type === 'any'
      ? { type, roomIds: current.room?.roomIds ?? [], groupId: current.room?.groupId ?? null }
      : { type: 'none' };
    parts.push({
      id,
      label: current.label || '',
      pattern,
      teacherIds: current.teacherIds,
      mode: current.mode === 'one_of' ? 'one_of' : 'together',
      room,
    });
  }
  return {
    sectionIds: input.sectionIds,
    subjectId: selectedSubject,
    activityName,
    syncGroup: input.syncGroup || null,
    parts,
  };
});
export type SaveLessonInput = z.output<typeof saveLessonSchema>;

export const copyLessonSchema = z.object({ sectionIds: z.array(sectionId).default([]).transform(unique) });
