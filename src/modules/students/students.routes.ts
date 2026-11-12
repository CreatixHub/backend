import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createGuardianSchema,
  createStudentDocumentSchema,
  createStudentHouseSchema,
  createStudentSchema,
  linkStudentGuardianSchema,
  listGuardiansSchema,
  listStudentHousesSchema,
  listStudentsSchema,
  updateGuardianSchema,
  updateStudentDocumentSchema,
  updateStudentGuardianSchema,
  updateStudentHouseSchema,
  updateStudentSchema,
  updateStudentStatusSchema,
  verifyStudentDocumentSchema,
} from './students.schemas';
import * as svc from './students.service';

// ---- /api/students
export const studentsRouter = Router();

studentsRouter.get('/', requirePermission('students.view'), async (req, res) => {
  const result = await svc.listStudents(currentTenant(req), listStudentsSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

studentsRouter.get('/:id', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.getStudent(currentTenant(req), parseId(req.params.id)));
});

studentsRouter.post('/', requirePermission('students.create'), async (req, res) => {
  created(res, await svc.createStudent(currentTenant(req), currentUser(req), createStudentSchema.parse(req.body)));
});

studentsRouter.patch('/:id', requirePermission('students.edit'), async (req, res) => {
  const input = updateStudentSchema.parse(req.body);
  ok(res, await svc.updateStudent(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

studentsRouter.patch('/:id/status', requirePermission('students.edit'), async (req, res) => {
  const input = updateStudentStatusSchema.parse(req.body);
  ok(res, await svc.updateStudentStatus(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

studentsRouter.delete('/:id', requirePermission('students.delete'), async (req, res) => {
  await svc.removeStudent(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/students/:id/guardians
studentsRouter.get('/:id/guardians', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.listStudentGuardians(currentTenant(req), parseId(req.params.id)));
});

studentsRouter.post('/:id/guardians', requirePermission('students.edit'), async (req, res) => {
  const input = linkStudentGuardianSchema.parse(req.body);
  created(res, await svc.linkStudentGuardian(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

studentsRouter.patch('/:id/guardians/:guardianId', requirePermission('students.edit'), async (req, res) => {
  const input = updateStudentGuardianSchema.parse(req.body);
  ok(
    res,
    await svc.updateStudentGuardian(
      currentTenant(req),
      currentUser(req),
      parseId(req.params.id),
      parseId(req.params.guardianId),
      input,
    ),
  );
});

studentsRouter.delete('/:id/guardians/:guardianId', requirePermission('students.edit'), async (req, res) => {
  await svc.unlinkStudentGuardian(
    currentTenant(req),
    currentUser(req),
    parseId(req.params.id),
    parseId(req.params.guardianId),
  );
  noContent(res);
});

// ---- /api/students/:id/documents
studentsRouter.get('/:id/documents', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.listStudentDocuments(currentTenant(req), parseId(req.params.id)));
});

studentsRouter.post('/:id/documents', requirePermission('students.edit'), async (req, res) => {
  const input = createStudentDocumentSchema.parse(req.body);
  created(res, await svc.addStudentDocument(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

studentsRouter.patch('/:id/documents/:docId', requirePermission('students.edit'), async (req, res) => {
  const input = updateStudentDocumentSchema.parse(req.body);
  ok(
    res,
    await svc.updateStudentDocument(
      currentTenant(req),
      currentUser(req),
      parseId(req.params.id),
      parseId(req.params.docId),
      input,
    ),
  );
});

studentsRouter.patch('/:id/documents/:docId/verify', requirePermission('students.edit'), async (req, res) => {
  const input = verifyStudentDocumentSchema.parse(req.body);
  ok(
    res,
    await svc.verifyStudentDocument(
      currentTenant(req),
      currentUser(req),
      parseId(req.params.id),
      parseId(req.params.docId),
      input,
    ),
  );
});

studentsRouter.delete('/:id/documents/:docId', requirePermission('students.edit'), async (req, res) => {
  await svc.removeStudentDocument(currentTenant(req), parseId(req.params.id), parseId(req.params.docId));
  noContent(res);
});

// ---- /api/guardians
export const guardiansRouter = Router();

guardiansRouter.get('/', requirePermission('students.view'), async (req, res) => {
  const result = await svc.listGuardians(currentTenant(req), listGuardiansSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});

guardiansRouter.get('/:id', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.getGuardian(currentTenant(req), parseId(req.params.id)));
});

guardiansRouter.post('/', requirePermission('students.create'), async (req, res) => {
  created(res, await svc.createGuardian(currentTenant(req), currentUser(req), createGuardianSchema.parse(req.body)));
});

guardiansRouter.patch('/:id', requirePermission('students.edit'), async (req, res) => {
  const input = updateGuardianSchema.parse(req.body);
  ok(res, await svc.updateGuardian(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

guardiansRouter.delete('/:id', requirePermission('students.delete'), async (req, res) => {
  await svc.removeGuardian(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});

// ---- /api/student-houses
export const studentHousesRouter = Router();

studentHousesRouter.get('/', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.listStudentHouses(currentTenant(req), listStudentHousesSchema.parse(req.query)));
});

studentHousesRouter.get('/:id', requirePermission('students.view'), async (req, res) => {
  ok(res, await svc.getStudentHouse(currentTenant(req), parseId(req.params.id)));
});

studentHousesRouter.post('/', requirePermission('students.create'), async (req, res) => {
  created(res, await svc.createStudentHouse(currentTenant(req), currentUser(req), createStudentHouseSchema.parse(req.body)));
});

studentHousesRouter.patch('/:id', requirePermission('students.edit'), async (req, res) => {
  const input = updateStudentHouseSchema.parse(req.body);
  ok(res, await svc.updateStudentHouse(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

studentHousesRouter.delete('/:id', requirePermission('students.delete'), async (req, res) => {
  await svc.removeStudentHouse(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});
