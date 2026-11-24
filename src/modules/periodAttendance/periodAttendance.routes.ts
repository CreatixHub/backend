import { Router } from 'express';
import { ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  listAttendanceSchema,
  listPeriodsSchema,
  saveSheetSchema,
  sheetQuerySchema,
  summarySchema,
} from './periodAttendance.schemas';
import * as svc from './periodAttendance.service';

// ---- /api/period-attendance  (attendance taken every period / hour)
export const periodAttendanceRouter = Router();

// The periods of a day. A teacher gets their own; attendance.manage gets every period (optionally one class).
periodAttendanceRouter.get('/periods', requirePermission('attendance.view'), async (req, res) => {
  ok(res, await svc.listPeriods(currentTenant(req), currentUser(req), listPeriodsSchema.parse(req.query)));
});

// The class list of one period on one date, with anything already marked.
periodAttendanceRouter.get('/sheet', requirePermission('attendance.view'), async (req, res) => {
  ok(res, await svc.getSheet(currentTenant(req), currentUser(req), sheetQuerySchema.parse(req.query)));
});

// Save the marks of one period (can be repeated to correct them).
periodAttendanceRouter.put('/sheet', requirePermission('attendance.create'), async (req, res) => {
  ok(res, await svc.saveSheet(currentTenant(req), currentUser(req), saveSheetSchema.parse(req.body)));
});

periodAttendanceRouter.get('/summary', requirePermission('attendance.view'), async (req, res) => {
  ok(res, await svc.summary(currentTenant(req), currentUser(req), summarySchema.parse(req.query)));
});

periodAttendanceRouter.get('/', requirePermission('attendance.view'), async (req, res) => {
  const result = await svc.listAttendance(currentTenant(req), currentUser(req), listAttendanceSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});