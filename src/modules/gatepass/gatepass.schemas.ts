import { z } from 'zod';

export const EXIT_PASS_STATUSES = ['pending', 'approved', 'rejected', 'used', 'expired', 'revoked'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const isoDateTime = z.string().datetime({ offset: true }).transform((v) => new Date(v));

export const listExitPassesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    studentId: id.optional(),
    status: z.enum(EXIT_PASS_STATUSES).optional(),
    reasonType: text(60).optional(),
    passCode: text(40).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .strict();

const exitPassCreateFields = {
  studentId: id,
  requestedByGuardianId: id.nullish(),
  requestedByStaffId: id.nullish(),
  reason: text(1000),
  reasonType: text(60),
  requestedExitAt: isoDateTime,
  expectedReturnAt: isoDateTime,
  pickedUpByGuardianId: id.nullish(),
  authorizedPersonName: text(120).nullish(),
  authorizedPersonRelation: text(60).nullish(),
  passCode: text(40).optional(),
};

export const createExitPassSchema = z
  .object(exitPassCreateFields)
  .strict()
  .refine((v) => v.expectedReturnAt >= v.requestedExitAt, {
    message: 'expectedReturnAt must be on or after requestedExitAt',
    path: ['expectedReturnAt'],
  });

export const updateExitPassSchema = z
  .object({
    reason: text(1000).optional(),
    reasonType: text(60).optional(),
    requestedExitAt: isoDateTime.optional(),
    expectedReturnAt: isoDateTime.optional(),
    pickedUpByGuardianId: id.nullish(),
    authorizedPersonName: text(120).nullish(),
    authorizedPersonRelation: text(60).nullish(),
  })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export const decideExitPassSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    rejectionReason: text(500).nullish(),
  })
  .strict();

export const verifyExitPassSchema = z
  .object({
    passCode: text(40),
  })
  .strict();

export const useExitPassSchema = z
  .object({
    pickedUpByGuardianId: id.nullish(),
    authorizedPersonName: text(120).nullish(),
    authorizedPersonRelation: text(60).nullish(),
    actualExitAt: isoDateTime.optional(),
  })
  .strict();

export const returnExitPassSchema = z
  .object({
    actualReturnAt: isoDateTime.optional(),
  })
  .strict();

export type ListExitPassesInput = z.infer<typeof listExitPassesSchema>;
export type CreateExitPassInput = z.infer<typeof createExitPassSchema>;
export type UpdateExitPassInput = z.infer<typeof updateExitPassSchema>;
export type DecideExitPassInput = z.infer<typeof decideExitPassSchema>;
export type VerifyExitPassInput = z.infer<typeof verifyExitPassSchema>;
export type UseExitPassInput = z.infer<typeof useExitPassSchema>;
export type ReturnExitPassInput = z.infer<typeof returnExitPassSchema>;
