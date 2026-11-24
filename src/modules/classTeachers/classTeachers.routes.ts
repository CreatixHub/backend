import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  assignClassTeacherSchema,
  listClassTeachersSchema,
  updateClassTeacherSchema,
} from './classTeachers.schemas';
import * as svc from './classTeachers.service';

// ---- /api/class-teachers  (uses the existing "classes" permissions)
export const classTeachersRouter = Router();

classTeachersRouter.get('/', requirePermission('classes.view'), async (req, res) => {
  const result = await svc.listClassTeachers(currentTenant(req), listClassTeachersSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

classTeachersRouter.get('/:id', requirePermission('classes.view'), async (req, res) => {
  ok(res, await svc.getClassTeacher(currentTenant(req), parseId(req.params.id)));
});

// Assign (or replace) the class teacher of a class.
classTeachersRouter.post('/', requirePermission('classes.edit'), async (req, res) => {
  created(
    res,
    await svc.assignClassTeacher(
      currentTenant(req),
      currentUser(req),
      assignClassTeacherSchema.parse(req.body),
    ),
  );
});

classTeachersRouter.patch('/:id', requirePermission('classes.edit'), async (req, res) => {
  const input = updateClassTeacherSchema.parse(req.body);
  ok(res, await svc.updateClassTeacher(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

classTeachersRouter.delete('/:id', requirePermission('classes.delete'), async (req, res) => {
  await svc.removeClassTeacher(currentTenant(req), parseId(req.params.id));
  noContent(res);
});