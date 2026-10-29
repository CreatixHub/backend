import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createRoleSchema, updateRoleSchema } from './roles.schemas';
import * as roles from './roles.service';

// GET /api/permissions
export const permissionsRouter = Router();
permissionsRouter.get('/', requirePermission('roles.view'), async (_req, res) => {
  ok(res, await roles.listPermissions());
});

// /api/roles
export const rolesRouter = Router();

rolesRouter.get('/', requirePermission('roles.view'), async (req, res) => {
  ok(res, await roles.listRoles(currentTenant(req)));
});

rolesRouter.post('/', requirePermission('roles.create'), async (req, res) => {
  created(res, await roles.createRole(currentTenant(req), createRoleSchema.parse(req.body)));
});

rolesRouter.patch('/:id', requirePermission('roles.edit'), async (req, res) => {
  ok(res, await roles.updateRole(currentTenant(req), parseId(req.params.id), updateRoleSchema.parse(req.body)));
});

rolesRouter.delete('/:id', requirePermission('roles.delete'), async (req, res) => {
  await roles.deleteRole(currentTenant(req), parseId(req.params.id));
  noContent(res);
});
