import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createAssignmentSchema,
  createDriverSchema,
  createPickupPointSchema,
  createRouteSchema,
  createScheduleSchema,
  createVehicleSchema,
  listAssignmentsSchema,
  listDriversSchema,
  listPickupPointsSchema,
  listRoutesSchema,
  listSchedulesSchema,
  listVehiclesSchema,
  updateAssignmentSchema,
  updateDriverSchema,
  updatePickupPointSchema,
  updateRouteSchema,
  updateScheduleSchema,
  updateVehicleSchema,
} from './transport.schemas';
import * as svc from './transport.service';

// ---- /api/vehicles
export const vehiclesRouter = Router();

vehiclesRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  const result = await svc.listVehicles(currentTenant(req), listVehiclesSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
vehiclesRouter.get('/:id', requirePermission('transport.view'), async (req, res) => {
  ok(res, await svc.getVehicle(currentTenant(req), parseId(req.params.id)));
});
vehiclesRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(res, await svc.createVehicle(currentTenant(req), currentUser(req), createVehicleSchema.parse(req.body)));
});
vehiclesRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updateVehicleSchema.parse(req.body);
  ok(res, await svc.updateVehicle(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
vehiclesRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.retireVehicle(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/drivers
export const driversRouter = Router();

driversRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  const result = await svc.listDrivers(currentTenant(req), listDriversSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
driversRouter.get('/:id', requirePermission('transport.view'), async (req, res) => {
  ok(res, await svc.getDriver(currentTenant(req), parseId(req.params.id)));
});
driversRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(res, await svc.createDriver(currentTenant(req), currentUser(req), createDriverSchema.parse(req.body)));
});
driversRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updateDriverSchema.parse(req.body);
  ok(res, await svc.updateDriver(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
driversRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.deactivateDriver(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/transport-routes
export const transportRoutesRouter = Router();

transportRoutesRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  const result = await svc.listRoutes(currentTenant(req), listRoutesSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
transportRoutesRouter.get('/:id', requirePermission('transport.view'), async (req, res) => {
  ok(res, await svc.getRoute(currentTenant(req), parseId(req.params.id)));
});
transportRoutesRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(res, await svc.createRoute(currentTenant(req), currentUser(req), createRouteSchema.parse(req.body)));
});
transportRoutesRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updateRouteSchema.parse(req.body);
  ok(res, await svc.updateRoute(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
transportRoutesRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.deactivateRoute(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/pickup-points
export const pickupPointsRouter = Router();

pickupPointsRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  ok(res, await svc.listPickupPoints(currentTenant(req), listPickupPointsSchema.parse(req.query)));
});
pickupPointsRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(
    res,
    await svc.createPickupPoint(currentTenant(req), currentUser(req), createPickupPointSchema.parse(req.body)),
  );
});
pickupPointsRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updatePickupPointSchema.parse(req.body);
  ok(res, await svc.updatePickupPoint(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
pickupPointsRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.removePickupPoint(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/route-schedules
export const routeSchedulesRouter = Router();

routeSchedulesRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  const result = await svc.listSchedules(currentTenant(req), listSchedulesSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
routeSchedulesRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(res, await svc.createSchedule(currentTenant(req), currentUser(req), createScheduleSchema.parse(req.body)));
});
routeSchedulesRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updateScheduleSchema.parse(req.body);
  ok(res, await svc.updateSchedule(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
routeSchedulesRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.removeSchedule(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/transport-assignments
export const transportAssignmentsRouter = Router();

transportAssignmentsRouter.get('/', requirePermission('transport.view'), async (req, res) => {
  const result = await svc.listAssignments(currentTenant(req), listAssignmentsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
transportAssignmentsRouter.post('/', requirePermission('transport.create'), async (req, res) => {
  created(
    res,
    await svc.createAssignment(currentTenant(req), currentUser(req), createAssignmentSchema.parse(req.body)),
  );
});
transportAssignmentsRouter.patch('/:id', requirePermission('transport.edit'), async (req, res) => {
  const input = updateAssignmentSchema.parse(req.body);
  ok(res, await svc.updateAssignment(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});
transportAssignmentsRouter.delete('/:id', requirePermission('transport.delete'), async (req, res) => {
  await svc.endAssignment(currentTenant(req), parseId(req.params.id));
  noContent(res);
});