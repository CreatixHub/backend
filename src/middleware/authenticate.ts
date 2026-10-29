import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import type { TenantContext } from '../lib/tenant';

// WHO is calling: a person (not a person-in-a-school; req.tenant adds that).
export interface AuthUser {
  id: bigint;
  email: string;
  fullName: string;
  phone: string | null;
  avatarUrl: string | null;
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
// UNTIL YOU FINISH IT, it rejects every request (safe default).
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // TODO 1: header must be "Authorization: Bearer <token>" -> otherwise throw new HttpError(401, 'Unauthorized')
  //         const [scheme, token] = (req.headers.authorization ?? '').split(' ')
  // TODO 2: verify the token; ANY failure (bad signature, expired, wrong shape) -> the same generic 401:
  //         const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] })
  //         payload is string | JwtPayload: require an object with a string "sub"; "tid" is optional (string)
  // TODO 3: load the person EVERY request: prisma.user.findFirst({ where: { id: BigInt(sub), status: 'active', deletedAt: null },
  //         select: { id, email, fullName, phone, avatarUrl } })   none -> 401
  // TODO 4: if payload has tid: const tenant = await loadTenantContext(user.id, BigInt(tid))
  //         tenant === null (membership or school suspended) -> 401  (the frontend then refreshes and falls back)
  // TODO 5: req.user = user; req.tenant = tenant (when present); next()
  void req; void next;
  throw new HttpError(401, 'Unauthorized');
}
