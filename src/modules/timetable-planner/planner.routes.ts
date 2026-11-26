import { Router, type Request } from 'express';
import { HttpError } from '../../lib/errors';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { resolveAcademicYearId } from '../academic-years/academicYears.service';
import * as lessons from './planner.lessons';
import { getPlannerState, getReadiness } from './planner.problem';
import {
  availabilityKindSchema, copyLessonSchema, createRoomGroupSchema, parsePlannerInput, plannerIdSchema,
  plannerYearQuerySchema, saveAvailabilitySchema, saveBellSchema, saveLessonSchema, saveRoomGroupSchema,
  saveRulesSchema, saveSectionExcludedSchema,
} from './planner.schemas';
import * as publish from './planner.publish';
import * as settings from './planner.settings';
import * as editing from './planner.editing';
import {
  blockSchema, createVersionSchema, generateVersionSchema, lockBlockSchema, positionSchema, publishVersionSchema, renameVersionSchema,
} from './planner.version-schemas';
import * as versions from './planner.versions';

export const plannerRouter = Router();
const edit = requirePermission('timetable.edit');
const pathId = (req: Request) => BigInt(parsePlannerInput(plannerIdSchema, req.params.id));

export async function resolvePlannerScope(req: Request) {
  const tenant = currentTenant(req);
  const { academicYearId } = parsePlannerInput(plannerYearQuerySchema, req.query);
  const yearId = await resolveAcademicYearId(tenant, academicYearId === undefined ? undefined : BigInt(academicYearId));
  return { tenant, yearId };
}

plannerRouter.get('/state', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const [state, yearVersions] = await Promise.all([getPlannerState(tenant, yearId), versions.listPlannerVersions(tenant, yearId)]);
  ok(res, { ...state, versions: yearVersions });
});

plannerRouter.patch('/bell', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await settings.saveBell(tenant, yearId, parsePlannerInput(saveBellSchema, req.body)));
});

plannerRouter.patch('/rules', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await settings.saveRules(tenant, yearId, parsePlannerInput(saveRulesSchema, req.body)));
});

plannerRouter.patch('/availability/:kind/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const kind = availabilityKindSchema.safeParse(req.params.kind);
  if (!kind.success) throw new HttpError(404, 'Availability can be set for staff, classes and rooms.');
  const { blocked } = parsePlannerInput(saveAvailabilitySchema, req.body);
  ok(res, await settings.saveAvailability(tenant, yearId, kind.data, pathId(req), blocked));
});

plannerRouter.patch('/sections/:id/excluded', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { excluded } = parsePlannerInput(saveSectionExcludedSchema, req.body);
  ok(res, await settings.saveSectionExcluded(tenant, yearId, pathId(req), excluded));
});

plannerRouter.post('/room-groups', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { name } = parsePlannerInput(createRoomGroupSchema, req.body);
  created(res, await settings.createRoomGroup(tenant, yearId, name));
});

plannerRouter.delete('/room-groups/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  await settings.deleteRoomGroup(tenant, yearId, pathId(req));
  noContent(res);
});

plannerRouter.patch('/rooms/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { groupId } = parsePlannerInput(saveRoomGroupSchema, req.body);
  ok(res, await settings.saveRoomGroup(tenant, yearId, pathId(req), groupId === null ? null : BigInt(groupId)));
});

plannerRouter.post('/lessons', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  created(res, await lessons.createLesson(tenant, yearId, parsePlannerInput(saveLessonSchema, req.body)));
});

plannerRouter.patch('/lessons/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await lessons.updateLesson(tenant, yearId, pathId(req), parsePlannerInput(saveLessonSchema, req.body)));
});

plannerRouter.delete('/lessons/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  await lessons.deleteLesson(tenant, yearId, pathId(req));
  noContent(res);
});

plannerRouter.post('/lessons/:id/copy', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { sectionIds } = parsePlannerInput(copyLessonSchema, req.body);
  created(res, await lessons.copyLesson(tenant, yearId, pathId(req), sectionIds));
});

plannerRouter.get('/readiness', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await getReadiness(tenant, yearId));
});

const create = requirePermission('timetable.create');
const deleteDraft = requirePermission('timetable.delete');
const manage = requirePermission('timetable.manage');

plannerRouter.post('/generate', create, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const input = parsePlannerInput(generateVersionSchema, req.body ?? {});
  created(res, await versions.generateVersion(tenant, yearId, currentUser(req).id, input));
});

plannerRouter.get('/versions', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await versions.listPlannerVersions(tenant, yearId));
});

plannerRouter.post('/versions', create, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { name } = parsePlannerInput(createVersionSchema, req.body ?? {});
  created(res, await versions.createBlankVersion(tenant, yearId, currentUser(req).id, name));
});

plannerRouter.get('/versions/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await versions.getVersionDetail(tenant, yearId, pathId(req)));
});

plannerRouter.patch('/versions/:id', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const { name } = parsePlannerInput(renameVersionSchema, req.body ?? {});
  ok(res, await versions.renameVersion(tenant, yearId, pathId(req), name));
});

plannerRouter.delete('/versions/:id', deleteDraft, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  await versions.deleteVersion(tenant, yearId, pathId(req));
  noContent(res);
});

plannerRouter.post('/versions/:id/duplicate', create, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  created(res, await versions.duplicateVersion(tenant, yearId, currentUser(req).id, pathId(req)));
});

plannerRouter.get('/versions/:id/reports', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await versions.getVersionReports(tenant, yearId, pathId(req)));
});

plannerRouter.get('/versions/:id/fit', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.getFit(tenant, yearId, pathId(req), parsePlannerInput(blockSchema, req.query)));
});

plannerRouter.get('/versions/:id/teacher-availability', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.getTeacherAvailability(tenant, yearId, pathId(req), parsePlannerInput(blockSchema, req.query)));
});

plannerRouter.post('/versions/:id/check-move', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.checkMove(tenant, yearId, pathId(req), parsePlannerInput(positionSchema, req.body ?? {})));
});

plannerRouter.post('/versions/:id/move', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.moveBlock(tenant, yearId, pathId(req), parsePlannerInput(positionSchema, req.body ?? {})));
});

plannerRouter.post('/versions/:id/place', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.placeBlock(tenant, yearId, pathId(req), parsePlannerInput(positionSchema, req.body ?? {})));
});

plannerRouter.post('/versions/:id/unschedule', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.unscheduleBlock(tenant, yearId, pathId(req), parsePlannerInput(blockSchema, req.body ?? {})));
});

plannerRouter.post('/versions/:id/lock', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await editing.lockBlock(tenant, yearId, pathId(req), parsePlannerInput(lockBlockSchema, req.body ?? {})));
});

plannerRouter.get('/versions/:id/publish-preview', edit, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  ok(res, await publish.previewPublish(tenant, pathId(req), yearId));
});

plannerRouter.post('/versions/:id/publish', manage, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  const input = parsePlannerInput(publishVersionSchema, req.body ?? {});
  created(res, await publish.publishVersion(tenant, currentUser(req), pathId(req), input, yearId));
});

plannerRouter.post('/versions/:id/restore', manage, async (req, res) => {
  const { tenant, yearId } = await resolvePlannerScope(req);
  await publish.restoreVersion(tenant, currentUser(req), pathId(req), yearId);
  ok(res, { restored: true });
});
