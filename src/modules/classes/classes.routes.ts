import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createClassSchema,
  createSectionSchema,
  listClassesSchema,
  listSectionsSchema,
  setClassSubjectsSchema,
  updateClassSchema,
  updateSectionSchema,
} from './classes.schemas';
import * as svc from './classes.service';

// ---- /api/classes
export const classesRouter = Router();

classesRouter.get('/', requirePermission('classes.view'), async (req, res) => {
  const result = await svc.listClasses(currentTenant(req), listClassesSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

classesRouter.get('/:id', requirePermission('classes.view'), async (req, res) => {
  ok(res, await svc.getClass(currentTenant(req), parseId(req.params.id)));
});

classesRouter.post('/', requirePermission('classes.create'), async (req, res) => {
  created(res, await svc.createClass(currentTenant(req), currentUser(req), createClassSchema.parse(req.body)));
});

classesRouter.patch('/:id', requirePermission('classes.edit'), async (req, res) => {
  const input = updateClassSchema.parse(req.body);
  ok(res, await svc.updateClass(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

classesRouter.delete('/:id', requirePermission('classes.delete'), async (req, res) => {
  await svc.removeClass(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});

classesRouter.get('/:id/subjects', requirePermission('classes.view'), async (req, res) => {
  ok(res, await svc.getClassSubjects(currentTenant(req), parseId(req.params.id)));
});

classesRouter.put('/:id/subjects', requirePermission('classes.edit'), async (req, res) => {
  const input = setClassSubjectsSchema.parse(req.body);
  ok(res, await svc.setClassSubjects(currentTenant(req), parseId(req.params.id), input));
});

// ---- /api/sections
export const sectionsRouter = Router();

sectionsRouter.get('/', requirePermission('classes.view'), async (req, res) => {
  const result = await svc.listSections(currentTenant(req), listSectionsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

sectionsRouter.get('/:id', requirePermission('classes.view'), async (req, res) => {
  ok(res, await svc.getSection(currentTenant(req), parseId(req.params.id)));
});

sectionsRouter.post('/', requirePermission('classes.create'), async (req, res) => {
  created(res, await svc.createSection(currentTenant(req), currentUser(req), createSectionSchema.parse(req.body)));
});

sectionsRouter.patch('/:id', requirePermission('classes.edit'), async (req, res) => {
  const input = updateSectionSchema.parse(req.body);
  ok(res, await svc.updateSection(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

sectionsRouter.delete('/:id', requirePermission('classes.delete'), async (req, res) => {
  await svc.removeSection(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});