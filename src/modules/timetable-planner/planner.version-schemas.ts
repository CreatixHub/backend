import { z } from 'zod';
import { plannerIdSchema, plannerYearQuerySchema } from './planner.schemas';

const nameError = 'Give the timetable a name.';
const name = z.string({ required_error: nameError }).trim().min(1, nameError);
const optionalName = z.string().trim().transform((value) => value || undefined).optional();

export const createVersionSchema = z.object({ name: optionalName });
export const renameVersionSchema = z.object({ name });
export const generateVersionSchema = createVersionSchema.extend({
  seed: z.number().int().min(-(2 ** 31)).max(2 ** 31 - 1).optional(),
  budgetMs: z.number().finite().optional(),
  versionId: plannerIdSchema.optional(),
  keepPlaced: z.boolean().optional(),
});

const blockError = 'Choose a lesson first.';
const blockId = z.string({ required_error: blockError, invalid_type_error: blockError }).trim().min(1, blockError);
export const blockSchema = z.object({ blockId });
export const blockQuerySchema = plannerYearQuerySchema.extend(blockSchema.shape);
export const positionSchema = blockSchema.extend({
  day: z.number().int().min(1).max(7),
  startNo: z.number().int().positive(),
});
export const lockBlockSchema = blockSchema.extend({ locked: z.boolean().default(true) });

const effectiveFromError = 'Enter the start date as YYYY-MM-DD.';
const isRealDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const publishVersionSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  effectiveFrom: z.string({ invalid_type_error: effectiveFromError }).trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, effectiveFromError).refine(isRealDate, effectiveFromError).optional(),
});
