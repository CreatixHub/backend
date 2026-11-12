import { and, eq, isNull } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../db';
import { users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { loadTenantContext } from '../lib/tenant';
import type { TenantContext } from '../lib/tenant';

// WHO is calling: a person (not a person-in-a-school; req.tenant adds that).
export interface AuthUser {
  id: bigint;
  username: string | null;
  email: string | null;
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
  avatarFileId: bigint | null;
  languageId: bigint | null;
  timezone: string | null;
  preferences: Record<string, unknown>;
  userType: string;
  status: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

// Use inside route handlers: the signed-in person, or 401.
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Unauthorized');
  return req.user;
}

// Use inside route handlers: the school this request acts in, or 403 if the token carries none.
export function currentTenant(req: Request): TenantContext {
  if (!req.tenant) throw new HttpError(403, 'Create or select a school first');
  return req.tenant;
}

// Turns a Bearer token into req.user (and req.tenant). Everything mounted AFTER it in app.ts needs a signed-in person.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // 1. the header must be exactly:  Authorization: Bearer <token>
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Unauthorized');

  // 2. verify the token; any problem (bad signature, expired, wrong shape) gives the same generic 401
  let sub: string;
  let tid: string | undefined;
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad payload');
    sub = payload.sub;
    tid = typeof payload.tid === 'string' ? payload.tid : undefined;
  } catch {
    throw new HttpError(401, 'Unauthorized');
  }

  // 3. load the person on EVERY request, so disabling an account takes effect immediately
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      fullName: users.fullName,
      phone: users.phone,
      avatarUrl: users.avatarUrl,
      avatarFileId: users.avatarFileId,
      languageId: users.languageId,
      timezone: users.timezone,
      preferences: users.preferences,
      userType: users.userType,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      mfaEnabled: users.mfaEnabled,
    })
    .from(users)
    .where(and(eq(users.id, BigInt(sub)), eq(users.status, 'active'), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw new HttpError(401, 'Unauthorized');

  // 4. if the token names a school, the membership and the school must still be active
  if (tid) {
    const tenant = await loadTenantContext(user.id, BigInt(tid));
    if (!tenant) throw new HttpError(401, 'Unauthorized');
    req.tenant = tenant;
  }

  req.user = user;
  next();
}
