import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { listNotificationsSchema, registerTokenSchema, removeTokenSchema } from './notifications.schemas';
import * as svc from './notifications.service';

// ---- /api/notifications  (every signed-in person reads only their OWN notifications, so no extra permission)
export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  ok(res, await svc.listMine(currentTenant(req), currentUser(req), listNotificationsSchema.parse(req.query)));
});

notificationsRouter.get('/unread-count', async (req, res) => {
  ok(res, await svc.unreadCount(currentTenant(req), currentUser(req)));
});

notificationsRouter.post('/read-all', async (req, res) => {
  ok(res, await svc.markAllRead(currentTenant(req), currentUser(req)));
});

// Register this phone for push notifications.
notificationsRouter.post('/push-token', async (req, res) => {
  ok(res, await svc.registerToken(currentTenant(req), currentUser(req), registerTokenSchema.parse(req.body)));
});

// Forget this phone (on logout).
notificationsRouter.post('/push-token/remove', async (req, res) => {
  ok(res, await svc.removeToken(currentUser(req), removeTokenSchema.parse(req.body).token));
});

notificationsRouter.post('/:id/read', async (req, res) => {
  ok(res, await svc.markRead(currentTenant(req), currentUser(req), parseId(req.params.id)));
});
notificationsRouter.post('/broadcast', async (req, res) => {
  const { broadcastNotificationSchema } =
    await import('./notifications.schemas');

  const input = broadcastNotificationSchema.parse(req.body);

  const result = await svc.broadcastNotification(
    currentTenant(req),
    currentUser(req),
    input,
  );

  ok(res, result);
});

