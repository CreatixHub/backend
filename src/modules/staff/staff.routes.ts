import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createStaffSchema, listStaffSchema, updateStaffSchema } from './staff.schemas';
import * as staffService from './staff.service';

export const staffRouter = Router();

staffRouter.get('/', requirePermission('staff.view'), async (req, res) => {
  const result = await staffService.listStaff(currentTenant(req), listStaffSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

staffRouter.get('/:id', requirePermission('staff.view'), async (req, res) => {
  ok(res, await staffService.getStaff(currentTenant(req), parseId(req.params.id)));
});

staffRouter.post('/', requirePermission('staff.create'), async (req, res) => {
  created(res, await staffService.createStaff(currentTenant(req), currentUser(req), createStaffSchema.parse(req.body)));
});

staffRouter.patch('/:id', requirePermission('staff.edit'), async (req, res) => {
  const input = updateStaffSchema.parse(req.body);
  ok(res, await staffService.updateStaff(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

staffRouter.delete('/:id', requirePermission('staff.delete'), async (req, res) => {
  await staffService.removeStaff(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});