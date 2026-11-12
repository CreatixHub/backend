import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createSubjectSchema, listSubjectsSchema, updateSubjectSchema } from './subjects.schemas';
import * as subjectsService from './subjects.service';

export const subjectsRouter = Router();

subjectsRouter.get('/', requirePermission('subjects.view'), async (req, res) => {
  const result = await subjectsService.listSubjects(currentTenant(req), listSubjectsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

subjectsRouter.get('/:id', requirePermission('subjects.view'), async (req, res) => {
  ok(res, await subjectsService.getSubject(currentTenant(req), parseId(req.params.id)));
});

subjectsRouter.post('/', requirePermission('subjects.create'), async (req, res) => {
  created(
    res,
    await subjectsService.createSubject(currentTenant(req), currentUser(req), createSubjectSchema.parse(req.body)),
  );
});

subjectsRouter.patch('/:id', requirePermission('subjects.edit'), async (req, res) => {
  const input = updateSubjectSchema.parse(req.body);
  ok(res, await subjectsService.updateSubject(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

subjectsRouter.delete('/:id', requirePermission('subjects.delete'), async (req, res) => {
  await subjectsService.removeSubject(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});