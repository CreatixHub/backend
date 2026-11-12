import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createExitPassSchema,
  decideExitPassSchema,
  listExitPassesSchema,
  returnExitPassSchema,
  updateExitPassSchema,
  useExitPassSchema,
  verifyExitPassSchema,
} from './gatepass.schemas';
import * as service from './gatepass.service';

// ================================================================ /api/exit-passes
export const exitPassesRouter = Router();

exitPassesRouter.get('/', requirePermission('gatepass.view'), async (req, res) => {
  const query = listExitPassesSchema.parse(req.query);
  const { rows, meta } = await service.listExitPasses(currentTenant(req), currentUser(req), query);
  ok(res, rows, meta);
});

exitPassesRouter.post('/verify', requirePermission('gatepass.view'), async (req, res) => {
  const body = verifyExitPassSchema.parse(req.body);
  ok(res, await service.verifyExitPassByCode(currentTenant(req), body));
});

exitPassesRouter.get('/:id', requirePermission('gatepass.view'), async (req, res) => {
  ok(res, await service.getExitPass(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

exitPassesRouter.post('/', requirePermission('gatepass.create'), async (req, res) => {
  const body = createExitPassSchema.parse(req.body);
  created(res, await service.createExitPass(currentTenant(req), currentUser(req), body));
});

exitPassesRouter.patch('/:id', requirePermission('gatepass.edit'), async (req, res) => {
  const body = updateExitPassSchema.parse(req.body);
  ok(res, await service.updateExitPass(currentTenant(req), currentUser(req), parseId(req.params.id), body));
});

exitPassesRouter.post('/:id/decide', requirePermission('gatepass.approve'), async (req, res) => {
  const body = decideExitPassSchema.parse(req.body);
  ok(res, await service.decideExitPass(currentTenant(req), currentUser(req), parseId(req.params.id), body));
});

exitPassesRouter.post('/:id/revoke', requirePermission('gatepass.edit'), async (req, res) => {
  ok(res, await service.revokeExitPass(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

exitPassesRouter.post('/:id/use', requirePermission('gatepass.edit'), async (req, res) => {
  const body = useExitPassSchema.parse(req.body ?? {});
  ok(res, await service.useExitPass(currentTenant(req), parseId(req.params.id), body));
});

exitPassesRouter.post('/:id/return', requirePermission('gatepass.edit'), async (req, res) => {
  const body = returnExitPassSchema.parse(req.body ?? {});
  ok(res, await service.recordExitPassReturn(currentTenant(req), parseId(req.params.id), body));
});
