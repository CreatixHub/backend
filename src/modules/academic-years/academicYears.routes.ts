import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, ok } from '../../lib/respond';
import { currentTenant } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createAcademicYearSchema, updateAcademicYearSchema } from './academicYears.schemas';
import * as svc from './academicYears.service';

// ---- /api/academic-years
export const academicYearsRouter = Router();

academicYearsRouter.get('/', requirePermission('academics.view'), async (req, res) => {
  ok(res, await svc.listAcademicYears(currentTenant(req)));
});

// NO permission code on purpose: any signed-in member of the school may read its current year id (it is not
// sensitive, and e.g. a receptionist needs it to create an admission). Still tenant-scoped through currentTenant().
academicYearsRouter.get('/current', async (req, res) => {
  ok(res, await svc.getCurrentAcademicYear(currentTenant(req)));
});

academicYearsRouter.post('/', requirePermission('academics.create'), async (req, res) => {
  created(res, await svc.createAcademicYear(currentTenant(req), createAcademicYearSchema.parse(req.body)));
});

academicYearsRouter.patch('/:id', requirePermission('academics.edit'), async (req, res) => {
  const input = updateAcademicYearSchema.parse(req.body);
  ok(res, await svc.updateAcademicYear(currentTenant(req), parseId(req.params.id), input));
});
