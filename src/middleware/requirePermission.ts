import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import { hasPermission } from '../lib/tenant';
import { currentTenant } from './authenticate';

// router.patch('/current', requirePermission('organization.edit'), handler)
// The caller must hold ALL listed permissions IN THE SCHOOL their token carries, otherwise 403.
export const requirePermission =
  (...codes: string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const tenant = currentTenant(req); // 403 if the token has no school
    if (!codes.every((code) => hasPermission(tenant, code))) {
      throw new HttpError(403, 'You do not have permission to do this');
    }
    next();
  };
