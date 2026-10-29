import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../config';
import { noContent, ok } from '../../lib/respond';
import { listMyOrganizations } from '../../lib/tenant';
import { currentUser } from '../../middleware/authenticate';
import { loginSchema, signupSchema, switchOrganizationSchema } from './auth.schemas';
import * as auth from './auth.service';
import { clearRefreshCookie, sendSession, toFrontendUser } from './session';
import type { ClientMeta } from './session';

const clientMeta = (req: Request): ClientMeta => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Slow down guessing: at most AUTH_RATE_LIMIT attempts per minute per IP.
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---- PUBLIC: mounted BEFORE authenticate (see the comments in app.ts) ----
export const publicAuthRouter = Router();

publicAuthRouter.post('/signup', authLimiter, async (req, res) => {
  const input = signupSchema.parse(req.body);
  sendSession(res, 201, await auth.signup(input, clientMeta(req)));
});

publicAuthRouter.post('/login', authLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  sendSession(res, 200, await auth.login(input, clientMeta(req)));
});

// No body: the refresh token is the httpOnly cookie "rt".
publicAuthRouter.post('/refresh', async (req, res) => {
  sendSession(res, 200, await auth.refresh(req.cookies?.rt, clientMeta(req)));
});

publicAuthRouter.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.rt);
  clearRefreshCookie(res);
  noContent(res);
});

// ---- PRIVATE: mounted AFTER authenticate ----
export const privateAuthRouter = Router();

// "Who am I, which school am I in, and which schools do I belong to?"
privateAuthRouter.get('/me', async (req, res) => {
  const user = currentUser(req);
  ok(res, { ...toFrontendUser(user, req.tenant ?? null), organizations: await listMyOrganizations(user.id) });
});

privateAuthRouter.post('/switch-organization', async (req, res) => {
  const { organization } = switchOrganizationSchema.parse(req.body);
  sendSession(res, 200, await auth.switchOrganization(currentUser(req).id, organization, req.cookies?.rt, clientMeta(req)));
});
