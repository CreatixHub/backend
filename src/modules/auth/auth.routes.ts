import { Router } from 'express';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../config';
import { noContent, ok } from '../../lib/respond';
import { listMyOrganizations } from '../../lib/tenant';
import { currentUser } from '../../middleware/authenticate';
import { loginSchema, mobileRefreshSchema, signupSchema, switchOrganizationSchema } from './auth.schemas';
import * as auth from './auth.service';
import { changePassword, changePasswordSchema } from './changePassword';
import { clearRefreshCookie, isMobileClient, sendSession, toFrontendUser } from './session';
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
  const mobile = isMobileClient(req);
  const input = signupSchema.parse(req.body);
  sendSession(res, 201, await auth.signup(input, clientMeta(req)), mobile);
});

publicAuthRouter.post('/login', authLimiter, async (req, res) => {
  const mobile = isMobileClient(req);
  const input = loginSchema.parse(req.body);
  sendSession(res, 200, await auth.login(input, clientMeta(req)), mobile);
});

// B3: Mobile clients send the refresh token in the JSON body; web clients use the httpOnly cookie.
publicAuthRouter.post('/refresh', async (req, res) => {
  const mobile = isMobileClient(req);
  let refreshToken: string | undefined;

  if (mobile) {
    // Accept the refresh token from the request body for mobile clients.
    const { refreshToken: bodyToken } = mobileRefreshSchema.parse(req.body);
    refreshToken = bodyToken;
  } else {
    // Web clients: the refresh token comes from the httpOnly cookie.
    refreshToken = req.cookies?.rt;
  }

  sendSession(res, 200, await auth.refresh(refreshToken, clientMeta(req)), mobile);
});

publicAuthRouter.post('/logout', async (req, res) => {
  const mobile = isMobileClient(req);
  let refreshToken: string | undefined;

  if (mobile) {
    // Mobile clients send the refresh token in the body to identify the session to revoke.
    refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
  } else {
    refreshToken = req.cookies?.rt;
  }

  await auth.logout(refreshToken);
  if (!mobile) clearRefreshCookie(res);
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
  const mobile = isMobileClient(req);
  const { organization } = switchOrganizationSchema.parse(req.body);
  const refreshToken = mobile
    ? (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined)
    : req.cookies?.rt;
  sendSession(res, 200, await auth.switchOrganization(currentUser(req).id, organization, refreshToken, clientMeta(req)), mobile);
});

// Change the signed-in user's own password (also used for the first-login forced change).
privateAuthRouter.post('/change-password', authLimiter, async (req, res) => {
  const input = changePasswordSchema.parse(req.body);
  await changePassword(currentUser(req), input, req.cookies?.rt);
  noContent(res);
});