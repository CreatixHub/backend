import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  acceptAdmissionSchema,
  changeAdmissionStatusSchema,
  createAdmissionSchema,
  listAdmissionsSchema,
  updateAdmissionSchema,
} from './admissions.schemas';
import * as svc from './admissions.service';

export const admissionsRouter = Router();

admissionsRouter.get('/', requirePermission('admissions.view'), async (req, res) => {
  const result = await svc.listAdmissions(currentTenant(req), listAdmissionsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

admissionsRouter.get('/:id', requirePermission('admissions.view'), async (req, res) => {
  ok(res, await svc.getAdmission(currentTenant(req), parseId(req.params.id)));
});

admissionsRouter.get('/:id/history', requirePermission('admissions.view'), async (req, res) => {
  ok(res, await svc.getAdmissionHistory(currentTenant(req), parseId(req.params.id)));
});

admissionsRouter.post('/', requirePermission('admissions.create'), async (req, res) => {
  created(res, await svc.createAdmission(currentTenant(req), currentUser(req), createAdmissionSchema.parse(req.body)));
});

admissionsRouter.patch('/:id', requirePermission('admissions.edit'), async (req, res) => {
  const input = updateAdmissionSchema.parse(req.body);
  ok(res, await svc.updateAdmission(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

admissionsRouter.post('/:id/status', requirePermission('admissions.edit'), async (req, res) => {
  const input = changeAdmissionStatusSchema.parse(req.body);
  ok(res, await svc.changeAdmissionStatus(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

admissionsRouter.post('/:id/accept', requirePermission('admissions.edit'), async (req, res) => {
  const input = acceptAdmissionSchema.parse(req.body ?? {});
  ok(res, await svc.acceptAdmission(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

admissionsRouter.delete('/:id', requirePermission('admissions.delete'), async (req, res) => {
  await svc.removeAdmission(currentTenant(req), parseId(req.params.id));
  noContent(res);
});
