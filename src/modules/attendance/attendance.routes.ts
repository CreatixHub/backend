import { Router } from 'express';
import { z } from 'zod';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  bulkMarkStaffAttendanceSchema,
  bulkMarkStudentAttendanceSchema,
  createAttendanceRuleSchema,
  createCalendarEventSchema,
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  decideLeaveRequestSchema,
  listAttendanceRulesSchema,
  listCalendarEventsSchema,
  listLeaveBalancesSchema,
  listLeaveRequestsSchema,
  listLeaveTypesSchema,
  listStaffAttendanceSchema,
  listStudentAttendanceSchema,
  updateAttendanceRuleSchema,
  updateCalendarEventSchema,
  updateLeaveBalanceSchema,
  updateLeaveRequestSchema,
  updateLeaveTypeSchema,
  upsertLeaveBalanceSchema,
  upsertStaffAttendanceSchema,
  upsertStudentAttendanceSchema,
} from './attendance.schemas';
import * as service from './attendance.service';

const dateParamSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

function parseDateParam(value: string | string[]): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = dateParamSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Invalid date parameter (use YYYY-MM-DD)');
  return parsed.data;
}

// ================================================================ /api/student-attendance
export const studentAttendanceRouter = Router();

studentAttendanceRouter.get('/', requirePermission('attendance.view'), async (req, res) => {
  const query = listStudentAttendanceSchema.parse(req.query);
  const { rows, meta } = await service.listStudentAttendance(currentTenant(req), query);
  ok(res, rows, meta);
});

studentAttendanceRouter.get('/:enrollmentId/:attendanceDate', requirePermission('attendance.view'), async (req, res) => {
  const row = await service.getStudentAttendance(
    currentTenant(req),
    parseId(req.params.enrollmentId),
    parseDateParam(req.params.attendanceDate),
  );
  ok(res, row);
});

studentAttendanceRouter.put(
  '/',
  requirePermission('attendance.create'),
  async (req, res) => {
    const body = upsertStudentAttendanceSchema.parse(req.body);
    const row = await service.upsertStudentAttendance(currentTenant(req), currentUser(req), body);
    ok(res, row);
  },
);

studentAttendanceRouter.post(
  '/bulk',
  requirePermission('attendance.create'),
  async (req, res) => {
    const body = bulkMarkStudentAttendanceSchema.parse(req.body);
    const rows = await service.bulkMarkStudentAttendance(currentTenant(req), currentUser(req), body);
    ok(res, rows);
  },
);

studentAttendanceRouter.delete(
  '/:enrollmentId/:attendanceDate',
  requirePermission('attendance.delete'),
  async (req, res) => {
    await service.deleteStudentAttendance(
      currentTenant(req),
      parseId(req.params.enrollmentId),
      parseDateParam(req.params.attendanceDate),
    );
    noContent(res);
  },
);

// ================================================================ /api/staff-attendance
export const staffAttendanceRouter = Router();

staffAttendanceRouter.get('/', requirePermission('attendance.view'), async (req, res) => {
  const query = listStaffAttendanceSchema.parse(req.query);
  const { rows, meta } = await service.listStaffAttendance(currentTenant(req), query);
  ok(res, rows, meta);
});

staffAttendanceRouter.get('/:staffId/:attendanceDate', requirePermission('attendance.view'), async (req, res) => {
  const row = await service.getStaffAttendance(
    currentTenant(req),
    parseId(req.params.staffId),
    parseDateParam(req.params.attendanceDate),
  );
  ok(res, row);
});

staffAttendanceRouter.put(
  '/',
  requirePermission('attendance.create'),
  async (req, res) => {
    const body = upsertStaffAttendanceSchema.parse(req.body);
    const row = await service.upsertStaffAttendance(currentTenant(req), currentUser(req), body);
    ok(res, row);
  },
);

staffAttendanceRouter.post(
  '/bulk',
  requirePermission('attendance.create'),
  async (req, res) => {
    const body = bulkMarkStaffAttendanceSchema.parse(req.body);
    const rows = await service.bulkMarkStaffAttendance(currentTenant(req), currentUser(req), body);
    ok(res, rows);
  },
);

staffAttendanceRouter.delete(
  '/:staffId/:attendanceDate',
  requirePermission('attendance.delete'),
  async (req, res) => {
    await service.deleteStaffAttendance(
      currentTenant(req),
      parseId(req.params.staffId),
      parseDateParam(req.params.attendanceDate),
    );
    noContent(res);
  },
);

// ================================================================ /api/attendance-rules
export const attendanceRulesRouter = Router();

attendanceRulesRouter.get('/', requirePermission('attendance.view'), async (req, res) => {
  const query = listAttendanceRulesSchema.parse(req.query);
  const { rows, meta } = await service.listAttendanceRules(currentTenant(req), query);
  ok(res, rows, meta);
});

attendanceRulesRouter.get('/:id', requirePermission('attendance.view'), async (req, res) => {
  ok(res, await service.getAttendanceRule(currentTenant(req), parseId(req.params.id)));
});

attendanceRulesRouter.post('/', requirePermission('attendance.manage'), async (req, res) => {
  const body = createAttendanceRuleSchema.parse(req.body);
  created(res, await service.createAttendanceRule(currentTenant(req), body));
});

attendanceRulesRouter.patch('/:id', requirePermission('attendance.manage'), async (req, res) => {
  const body = updateAttendanceRuleSchema.parse(req.body);
  ok(res, await service.updateAttendanceRule(currentTenant(req), parseId(req.params.id), body));
});

attendanceRulesRouter.delete('/:id', requirePermission('attendance.manage'), async (req, res) => {
  await service.deleteAttendanceRule(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/calendar-events
export const calendarEventsRouter = Router();

calendarEventsRouter.get('/', requirePermission('calendar.view'), async (req, res) => {
  const query = listCalendarEventsSchema.parse(req.query);
  const { rows, meta } = await service.listCalendarEvents(currentTenant(req), query);
  ok(res, rows, meta);
});

calendarEventsRouter.get('/:id', requirePermission('calendar.view'), async (req, res) => {
  ok(res, await service.getCalendarEvent(currentTenant(req), parseId(req.params.id)));
});

calendarEventsRouter.post('/', requirePermission('calendar.create'), async (req, res) => {
  const body = createCalendarEventSchema.parse(req.body);
  created(res, await service.createCalendarEvent(currentTenant(req), body));
});

calendarEventsRouter.patch('/:id', requirePermission('calendar.edit'), async (req, res) => {
  const body = updateCalendarEventSchema.parse(req.body);
  ok(res, await service.updateCalendarEvent(currentTenant(req), parseId(req.params.id), body));
});

calendarEventsRouter.delete('/:id', requirePermission('calendar.delete'), async (req, res) => {
  await service.deleteCalendarEvent(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/leave-types
export const leaveTypesRouter = Router();

leaveTypesRouter.get('/', requirePermission('leaves.view'), async (req, res) => {
  const query = listLeaveTypesSchema.parse(req.query);
  const { rows, meta } = await service.listLeaveTypes(currentTenant(req), query);
  ok(res, rows, meta);
});

leaveTypesRouter.get('/:id', requirePermission('leaves.view'), async (req, res) => {
  ok(res, await service.getLeaveType(currentTenant(req), parseId(req.params.id)));
});

leaveTypesRouter.post('/', requirePermission('leaves.manage'), async (req, res) => {
  const body = createLeaveTypeSchema.parse(req.body);
  created(res, await service.createLeaveType(currentTenant(req), body));
});

leaveTypesRouter.patch('/:id', requirePermission('leaves.manage'), async (req, res) => {
  const body = updateLeaveTypeSchema.parse(req.body);
  ok(res, await service.updateLeaveType(currentTenant(req), parseId(req.params.id), body));
});

leaveTypesRouter.delete('/:id', requirePermission('leaves.manage'), async (req, res) => {
  await service.deleteLeaveType(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/leave-requests
export const leaveRequestsRouter = Router();

leaveRequestsRouter.get('/', requirePermission('leaves.view'), async (req, res) => {
  const query = listLeaveRequestsSchema.parse(req.query);
  const { rows, meta } = await service.listLeaveRequests(currentTenant(req), currentUser(req), query);
  ok(res, rows, meta);
});

leaveRequestsRouter.get('/:id', requirePermission('leaves.view'), async (req, res) => {
  ok(res, await service.getLeaveRequest(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

leaveRequestsRouter.post('/', requirePermission('leaves.create'), async (req, res) => {
  const body = createLeaveRequestSchema.parse(req.body);
  created(res, await service.createLeaveRequest(currentTenant(req), currentUser(req), body));
});

leaveRequestsRouter.patch('/:id', requirePermission('leaves.edit'), async (req, res) => {
  const body = updateLeaveRequestSchema.parse(req.body);
  ok(res, await service.updateLeaveRequest(currentTenant(req), currentUser(req), parseId(req.params.id), body));
});

leaveRequestsRouter.post('/:id/decide', requirePermission('leaves.approve'), async (req, res) => {
  const body = decideLeaveRequestSchema.parse(req.body);
  ok(res, await service.decideLeaveRequest(currentTenant(req), currentUser(req), parseId(req.params.id), body));
});

leaveRequestsRouter.post('/:id/cancel', requirePermission('leaves.edit'), async (req, res) => {
  ok(res, await service.cancelLeaveRequest(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

// ================================================================ /api/leave-balances
export const leaveBalancesRouter = Router();

leaveBalancesRouter.get('/', requirePermission('leaves.view'), async (req, res) => {
  const query = listLeaveBalancesSchema.parse(req.query);
  const { rows, meta } = await service.listLeaveBalances(currentTenant(req), query);
  ok(res, rows, meta);
});

leaveBalancesRouter.get('/:id', requirePermission('leaves.view'), async (req, res) => {
  ok(res, await service.getLeaveBalance(currentTenant(req), parseId(req.params.id)));
});

leaveBalancesRouter.put('/', requirePermission('leaves.manage'), async (req, res) => {
  const body = upsertLeaveBalanceSchema.parse(req.body);
  ok(res, await service.upsertLeaveBalance(currentTenant(req), body));
});

leaveBalancesRouter.patch('/:id', requirePermission('leaves.manage'), async (req, res) => {
  const body = updateLeaveBalanceSchema.parse(req.body);
  ok(res, await service.updateLeaveBalance(currentTenant(req), parseId(req.params.id), body));
});

leaveBalancesRouter.delete('/:id', requirePermission('leaves.manage'), async (req, res) => {
  await service.deleteLeaveBalance(currentTenant(req), parseId(req.params.id));
  noContent(res);
});
