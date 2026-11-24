import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devicePushTokens, notifications } from '../../db/schema';
import { logger } from '../../lib/logger';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type { ListNotificationsInput, RegisterTokenInput } from './notifications.schemas';

// RULES: every query has tenantId = tenant.id, and a person only ever sees their own notifications.

export type NewNotification = {
  userId: bigint;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

// ---------------------------------------------------------------- creating (called by other modules)
// Saves one notification row per recipient, then tries to push it to their phones.
// This NEVER throws: a failed notification must not break the thing that triggered it.
export async function notifyUsers(tenantId: bigint, items: NewNotification[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const rows = await db
      .insert(notifications)
      .values(
        items.map((n) => ({
          tenantId,
          userId: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          data: n.data ?? {},
        })),
      )
      .returning({ id: notifications.id, userId: notifications.userId });

    // fire and forget: the HTTP response does not wait for the push service
    void sendPush(
      tenantId,
      items.map((n, i) => ({ ...n, notificationId: rows[i]?.id })),
    ).catch((e) => logger.warn({ err: e }, 'push notification failed'));
  } catch (e) {
    logger.error({ err: e }, 'could not create notifications');
  }
}

// ---------------------------------------------------------------- phone push (Expo push service)
const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPush(tenantId: bigint, items: (NewNotification & { notificationId?: bigint })[]) {
  const userIds = [...new Set(items.map((i) => i.userId))];
  const tokens = await db
    .select({ token: devicePushTokens.token, userId: devicePushTokens.userId })
    .from(devicePushTokens)
    .where(and(eq(devicePushTokens.tenantId, tenantId), inArray(devicePushTokens.userId, userIds)));
  if (tokens.length === 0) return;

  const messages = tokens.flatMap((t) =>
    items
      .filter((i) => i.userId === t.userId)
      .map((i) => ({
        to: t.token,
        title: i.title,
        body: i.body,
        sound: 'default',
        channelId: 'default',
        data: { ...(i.data ?? {}), type: i.type },
      })),
  );

  const dead: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const res = await fetch(EXPO_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Expo push service answered with an error');
      continue;
    }
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    (json.data ?? []).forEach((r, idx) => {
      if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') dead.push(chunk[idx].to);
    });
  }

  // phones that uninstalled the app: forget their tokens
  if (dead.length > 0) await db.delete(devicePushTokens).where(inArray(devicePushTokens.token, dead));

  const ids = items.map((i) => i.notificationId).filter((x): x is bigint => x !== undefined);
  if (ids.length > 0) {
    await db.update(notifications).set({ pushSentAt: sql`CURRENT_TIMESTAMP` }).where(inArray(notifications.id, ids));
  }
}

// ---------------------------------------------------------------- reading (the signed-in person's own)
export async function listMine(tenant: TenantContext, actor: AuthUser, q: ListNotificationsInput) {
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenant.id),
        eq(notifications.userId, actor.id),
        q.unread ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(q.limit);
}

export async function unreadCount(tenant: TenantContext, actor: AuthUser) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.userId, actor.id), isNull(notifications.readAt)));
  return { count: row?.n ?? 0 };
}

export async function markRead(tenant: TenantContext, actor: AuthUser, id: bigint) {
  await db
    .update(notifications)
    .set({ readAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.tenantId, tenant.id),
        eq(notifications.userId, actor.id),
        isNull(notifications.readAt),
      ),
    );
  return unreadCount(tenant, actor);
}

export async function markAllRead(tenant: TenantContext, actor: AuthUser) {
  await db
    .update(notifications)
    .set({ readAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(notifications.tenantId, tenant.id), eq(notifications.userId, actor.id), isNull(notifications.readAt)));
  return { count: 0 };
}

// ---------------------------------------------------------------- phone tokens
// A phone token belongs to whoever signed in on it last.
export async function registerToken(tenant: TenantContext, actor: AuthUser, input: RegisterTokenInput) {
  await db
    .insert(devicePushTokens)
    .values({ tenantId: tenant.id, userId: actor.id, token: input.token, platform: input.platform ?? null })
    .onConflictDoUpdate({
      target: devicePushTokens.token,
      set: { tenantId: tenant.id, userId: actor.id, platform: input.platform ?? null, updatedAt: new Date() },
    });
  return { registered: true };
}

export async function removeToken(actor: AuthUser, token: string) {
  await db.delete(devicePushTokens).where(and(eq(devicePushTokens.token, token), eq(devicePushTokens.userId, actor.id)));
  return { removed: true };
}