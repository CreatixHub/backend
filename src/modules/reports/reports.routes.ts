import { Router } from 'express';
import { ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import * as svc from './reports.service';

export const reportsRouter = Router();

// Needs permission to view both staff and students.
reportsRouter.get(
  '/school-strength',
  requirePermission('staff.view'),
  requirePermission('students.view'),
  async (req, res) => {
    ok(res, await svc.schoolStrength(currentTenant(req)));
  },
);