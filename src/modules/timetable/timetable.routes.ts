import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createEntrySchema,
  createSectionTeacherSchema,
  createTimeSlotSchema,
  listEntriesSchema,
  listSectionTeachersSchema,
  listTimeSlotsSchema,
  updateEntrySchema,
  updateSectionTeacherSchema,
  updateTimeSlotSchema,
} from './timetable.schemas';
import * as svc from './timetable.service';

// ---- /api/time-slots
export const timeSlotsRouter = Router();

timeSlotsRouter.get('/', requirePermission('timetable.view'), async (req, res) => {
  ok(res, await svc.listTimeSlots(currentTenant(req), listTimeSlotsSchema.parse(req.query)));
});

timeSlotsRouter.post('/', requirePermission('timetable.create'), async (req, res) => {
  created(res, await svc.createTimeSlot(currentTenant(req), currentUser(req), createTimeSlotSchema.parse(req.body)));
});

timeSlotsRouter.patch('/:id', requirePermission('timetable.edit'), async (req, res) => {
  const input = updateTimeSlotSchema.parse(req.body);
  ok(res, await svc.updateTimeSlot(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

timeSlotsRouter.delete('/:id', requirePermission('timetable.delete'), async (req, res) => {
  await svc.removeTimeSlot(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/section-teachers
export const sectionTeachersRouter = Router();

sectionTeachersRouter.get('/', requirePermission('timetable.view'), async (req, res) => {
  const result = await svc.listSectionTeachers(currentTenant(req), listSectionTeachersSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

sectionTeachersRouter.post('/', requirePermission('timetable.create'), async (req, res) => {
  created(
    res,
    await svc.createSectionTeacher(currentTenant(req), currentUser(req), createSectionTeacherSchema.parse(req.body)),
  );
});

sectionTeachersRouter.patch('/:id', requirePermission('timetable.edit'), async (req, res) => {
  const input = updateSectionTeacherSchema.parse(req.body);
  ok(res, await svc.updateSectionTeacher(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

sectionTeachersRouter.delete('/:id', requirePermission('timetable.delete'), async (req, res) => {
  await svc.removeSectionTeacher(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/timetable
export const timetableRouter = Router();

timetableRouter.get('/', requirePermission('timetable.view'), async (req, res) => {
  const result = await svc.listEntries(currentTenant(req), listEntriesSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

timetableRouter.post('/', requirePermission('timetable.create'), async (req, res) => {
  created(res, await svc.createEntry(currentTenant(req), currentUser(req), createEntrySchema.parse(req.body)));
});

timetableRouter.patch('/:id', requirePermission('timetable.edit'), async (req, res) => {
  const input = updateEntrySchema.parse(req.body);
  ok(res, await svc.updateEntry(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

timetableRouter.delete('/:id', requirePermission('timetable.delete'), async (req, res) => {
  await svc.removeEntry(currentTenant(req), parseId(req.params.id));
  noContent(res);
});