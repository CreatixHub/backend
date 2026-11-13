import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createAllocationSchema,
  createAssetSchema,
  createCategorySchema,
  createMaintenanceSchema,
  disposeAssetSchema,
  listAllocationsSchema,
  listAssetsSchema,
  listMaintenanceSchema,
  returnAllocationSchema,
  updateAllocationSchema,
  updateAssetSchema,
  updateCategorySchema,
  updateMaintenanceSchema,
} from './assets.schemas';
import * as svc from './assets.service';

// ---- /api/asset-categories
export const assetCategoriesRouter = Router();

assetCategoriesRouter.get('/', requirePermission('assets.view'), async (req, res) => {
  ok(res, await svc.listCategories(currentTenant(req)));
});
assetCategoriesRouter.post('/', requirePermission('assets.create'), async (req, res) => {
  created(res, await svc.createCategory(currentTenant(req), currentUser(req), createCategorySchema.parse(req.body)));
});
assetCategoriesRouter.patch('/:id', requirePermission('assets.edit'), async (req, res) => {
  const input = updateCategorySchema.parse(req.body);
  ok(res, await svc.updateCategory(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
assetCategoriesRouter.delete('/:id', requirePermission('assets.delete'), async (req, res) => {
  await svc.deleteCategory(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/assets
export const assetsRouter = Router();

assetsRouter.get('/', requirePermission('assets.view'), async (req, res) => {
  const result = await svc.listAssets(currentTenant(req), listAssetsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
assetsRouter.get('/:id', requirePermission('assets.view'), async (req, res) => {
  ok(res, await svc.getAsset(currentTenant(req), parseId(req.params.id)));
});
assetsRouter.post('/', requirePermission('assets.create'), async (req, res) => {
  created(res, await svc.createAsset(currentTenant(req), currentUser(req), createAssetSchema.parse(req.body)));
});
assetsRouter.patch('/:id', requirePermission('assets.edit'), async (req, res) => {
  const input = updateAssetSchema.parse(req.body);
  ok(res, await svc.updateAsset(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
// dispose with details (date, value, notes)
assetsRouter.post('/:id/dispose', requirePermission('assets.delete'), async (req, res) => {
  const input = disposeAssetSchema.parse(req.body ?? {});
  ok(res, await svc.disposeAsset(currentTenant(req), parseId(req.params.id), input));
});
// dispose with today's date and no details
assetsRouter.delete('/:id', requirePermission('assets.delete'), async (req, res) => {
  await svc.disposeAsset(currentTenant(req), parseId(req.params.id), {});
  noContent(res);
});

// ---- /api/asset-allocations
export const assetAllocationsRouter = Router();

assetAllocationsRouter.get('/', requirePermission('assets.view'), async (req, res) => {
  const result = await svc.listAllocations(currentTenant(req), currentUser(req), listAllocationsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
assetAllocationsRouter.post('/', requirePermission('assets.create'), async (req, res) => {
  created(res, await svc.createAllocation(currentTenant(req), currentUser(req), createAllocationSchema.parse(req.body)));
});
assetAllocationsRouter.patch('/:id', requirePermission('assets.edit'), async (req, res) => {
  const input = updateAllocationSchema.parse(req.body);
  ok(res, await svc.updateAllocation(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
assetAllocationsRouter.post('/:id/return', requirePermission('assets.edit'), async (req, res) => {
  const input = returnAllocationSchema.parse(req.body);
  ok(res, await svc.returnAllocation(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

// ---- /api/asset-maintenance
export const assetMaintenanceRouter = Router();

assetMaintenanceRouter.get('/', requirePermission('assets.view'), async (req, res) => {
  const result = await svc.listMaintenance(currentTenant(req), listMaintenanceSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
assetMaintenanceRouter.post('/', requirePermission('assets.create'), async (req, res) => {
  created(res, await svc.createMaintenance(currentTenant(req), currentUser(req), createMaintenanceSchema.parse(req.body)));
});
assetMaintenanceRouter.patch('/:id', requirePermission('assets.edit'), async (req, res) => {
  const input = updateMaintenanceSchema.parse(req.body);
  ok(res, await svc.updateMaintenance(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
assetMaintenanceRouter.delete('/:id', requirePermission('assets.delete'), async (req, res) => {
  await svc.cancelMaintenance(currentTenant(req), parseId(req.params.id));
  noContent(res);
});