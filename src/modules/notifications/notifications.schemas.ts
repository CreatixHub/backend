import { z } from 'zod';

const id = z.coerce.bigint().positive();

export const listNotificationsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    unread: z.enum(['1', 'true']).optional(), // only unread ones
  })
  .strict();

export const registerTokenSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(10)
      .max(200)
      .regex(/^(Exponent|Expo)PushToken\[.+\]$/, 'Not an Expo push token'),
    platform: z.enum(['android', 'ios']).optional(),
  })
  .strict();

export const removeTokenSchema = z.object({ token: z.string().trim().min(10).max(200) }).strict();

export const notificationIdSchema = z.object({ id }).strict();

export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
export type RegisterTokenInput = z.infer<typeof registerTokenSchema>;
export const broadcastNotificationSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    body: z.string().trim().min(1).max(2000),
  })
  .strict();

export type BroadcastNotificationInput =
  z.infer<typeof broadcastNotificationSchema>;

