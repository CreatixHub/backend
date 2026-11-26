import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { resolveAcademicYearId } from '../academic-years/academicYears.service';
import { createStaffSchema, listStaffSchema, updateStaffSchema } from './staff.schemas';
import * as staffService from './staff.service';
import * as me from './staff.me';
import { addAssignments, addAssignmentsSchema, assignmentYearQuery, removeAssignment } from './staff.assignAdmin';

export const staffRouter = Router();

staffRouter.get('/', requirePermission('staff.view'), async (req, res) => {
  const result = await staffService.listStaff(currentTenant(req), listStaffSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

// ---- the signed-in staff member's own data (no permission needed; tied to their own login) ----
// These must stay ABOVE '/:id', otherwise "me" would be treated as an id.
staffRouter.get('/me', async (req, res) => {
  ok(res, await staffService.getMyStaff(currentTenant(req), currentUser(req)));
});

staffRouter.get('/me/sections', async (req, res) => {
  ok(res, await me.getMySections(currentTenant(req), currentUser(req)));
});

staffRouter.get('/me/timetable', async (req, res) => {
  const { rows, today } = await me.getMyTimetable(currentTenant(req), currentUser(req));
  ok(res, rows, { today });
});

staffRouter.get('/me/assignments', async (req, res) => {
  ok(res, await me.getMyAssignments(currentTenant(req), currentUser(req)));
});

staffRouter.get('/me/homework', async (req, res) => {
  ok(res, await me.getMyHomework(currentTenant(req), currentUser(req)));
});

// ---- any teacher, by id (admin side) ----
staffRouter.get('/:id/assignments', requirePermission('staff.view'), async (req, res) => {
  const tenant = currentTenant(req);
  const { academicYearId } = assignmentYearQuery.parse(req.query);
  const yearId = academicYearId === undefined ? undefined : await resolveAcademicYearId(tenant, academicYearId);
  ok(res, await me.getStaffAssignments(tenant, parseId(req.params.id), yearId));
});

staffRouter.get('/:id/timetable', requirePermission('staff.view'), async (req, res) => {
  const { rows, today } = await me.getStaffTimetable(currentTenant(req), parseId(req.params.id));
  ok(res, rows, { today });
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

// Add classes + subjects to an existing teacher.
staffRouter.post('/:id/assignments', requirePermission('staff.edit'), async (req, res) => {
  const input = addAssignmentsSchema.parse(req.body);
  await addAssignments(currentTenant(req), parseId(req.params.id), input);
  ok(res, { saved: input.assignments.length });
});

// Remove one subject of one class (all its sections) from a teacher.
staffRouter.delete('/:id/assignments/:classId/:subjectId', requirePermission('staff.edit'), async (req, res) => {
  const { academicYearId } = assignmentYearQuery.parse(req.query);
  await removeAssignment(
    currentTenant(req),
    parseId(req.params.id),
    parseId(req.params.classId),
    parseId(req.params.subjectId),
    academicYearId,
  );
  noContent(res);
});

staffRouter.delete('/:id', requirePermission('staff.delete'), async (req, res) => {
  await staffService.removeStaff(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});
