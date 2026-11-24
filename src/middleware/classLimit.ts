import type { NextFunction, Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { admissions } from '../db/schema';
import { allowedClassIds, classLimitStore, isClassLimited } from '../lib/classAccess';
import { parseId } from '../lib/bigint';
import { HttpError } from '../lib/errors';
import { currentTenant, currentUser } from './authenticate';

/** Runs for every admissions request: if the caller is a limited Admission Officer, remember their classes. */
export async function classLimitMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const tenant = currentTenant(req);
    if (!isClassLimited(tenant)) return next();
    const ids = await allowedClassIds(tenant, currentUser(req).id);
    (req as any).classLimit = ids;
    if (req.method === 'POST' && req.path === '/' && req.body?.classId != null) {
      if (!ids.map(String).includes(String(req.body.classId))) {
        throw new HttpError(403, 'You can only add admissions for the classes assigned to you');
      }
    }
    classLimitStore.run({ ids }, () => next());
  } catch (e) {
    next(e);
  }
}

/** Runs for every /:id admissions route: an admission outside the officer's classes is "not found". */
export async function classParamGuard(req: Request, _res: Response, next: NextFunction, id: string) {
  try {
    const ids = (req as any).classLimit as bigint[] | undefined;
    if (!ids) return next();
    const tenant = currentTenant(req);
    const [row] = await db
      .select({ classId: admissions.classId })
      .from(admissions)
      .where(and(eq(admissions.id, parseId(id)), eq(admissions.tenantId, tenant.id), isNull(admissions.deletedAt)))
      .limit(1);
    if (row && !ids.includes(row.classId)) throw new HttpError(404, 'Admission not found');
    next();
  } catch (e) {
    next(e);
  }
}