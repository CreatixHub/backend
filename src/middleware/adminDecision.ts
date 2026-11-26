import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import { currentTenant } from './authenticate';

const DECISIONS = new Set(['offered', 'accepted', 'rejected']);

/** Accepting, offering or rejecting an admission is the admin's decision. */
export function adminDecision(req: Request, _res: Response, next: NextFunction) {
  const t = currentTenant(req);
  const isAdmin = t.permissions.has('*') || t.roles.includes('admin');
  const status = (req.body as { status?: string } | undefined)?.status;
  const isAccept = req.path.endsWith('/accept');
  if (!isAdmin && (isAccept || (status && DECISIONS.has(status)))) {
    return next(new HttpError(403, 'Only the admin can approve or reject an admission'));
  }
  next();
}