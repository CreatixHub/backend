import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createHomeworkSchema,
  gradeSubmissionSchema,
  listHomeworkSchema,
  listSubmissionsSchema,
  recordSubmissionSchema,
  updateHomeworkSchema,
} from './homework.schemas';
import * as svc from './homework.service';

// ---- /api/homework
export const homeworkRouter = Router();

homeworkRouter.get('/', requirePermission('homework.view'), async (req, res) => {
  const result = await svc.listHomework(currentTenant(req), listHomeworkSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

homeworkRouter.get('/:id', requirePermission('homework.view'), async (req, res) => {
  ok(res, await svc.getHomework(currentTenant(req), parseId(req.params.id)));
});

homeworkRouter.post('/', requirePermission('homework.create'), async (req, res) => {
  created(res, await svc.createHomework(currentTenant(req), currentUser(req), createHomeworkSchema.parse(req.body)));
});

homeworkRouter.patch('/:id', requirePermission('homework.edit'), async (req, res) => {
  const input = updateHomeworkSchema.parse(req.body);
  ok(res, await svc.updateHomework(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

homeworkRouter.post('/:id/publish', requirePermission('homework.edit'), async (req, res) => {
  ok(res, await svc.publishHomework(currentTenant(req), parseId(req.params.id)));
});

homeworkRouter.post('/:id/close', requirePermission('homework.edit'), async (req, res) => {
  ok(res, await svc.closeHomework(currentTenant(req), parseId(req.params.id)));
});

homeworkRouter.delete('/:id', requirePermission('homework.delete'), async (req, res) => {
  await svc.removeHomework(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

homeworkRouter.get('/:id/submissions', requirePermission('homework.view'), async (req, res) => {
  const result = await svc.listSubmissions(
    currentTenant(req),
    parseId(req.params.id),
    listSubmissionsSchema.parse(req.query),
  );
  ok(res, result.rows, result.meta);
});

homeworkRouter.post('/:id/submissions', requirePermission('homework.edit'), async (req, res) => {
  const input = recordSubmissionSchema.parse(req.body);
  created(res, await svc.recordSubmission(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

// ---- /api/homework-submissions
export const homeworkSubmissionsRouter = Router();

homeworkSubmissionsRouter.patch('/:id/grade', requirePermission('homework.edit'), async (req, res) => {
  const input = gradeSubmissionSchema.parse(req.body);
  ok(res, await svc.gradeSubmission(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});