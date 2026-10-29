import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { created, ok } from '../../lib/respond';
import { listMyOrganizations } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { createOrganizationSchema, updateOrganizationSchema } from './organizations.schemas';
import * as orgs from './organizations.service';

// Anyone signed in can create schools, so cap it: 20 per hour per IP.
const createLimiter = rateLimit({ windowMs: 3_600_000, limit: 20, standardHeaders: true, legacyHeaders: false });

export const organizationsRouter = Router();

// ---- about the PERSON (no school needed in the token) ----
organizationsRouter.post('/', createLimiter, async (req, res) => {
  const input = createOrganizationSchema.parse(req.body);
  created(res, await orgs.createOrganization(input, currentUser(req), req.ip));
});

organizationsRouter.get('/', async (req, res) => {
  ok(res, await listMyOrganizations(currentUser(req).id));
});

// ---- INSIDE the school the token carries, with the right permission ----
organizationsRouter.get('/current', requirePermission('organization.view'), async (req, res) => {
  ok(res, await orgs.currentOrganization(currentTenant(req)));
});

organizationsRouter.patch('/current', requirePermission('organization.edit'), async (req, res) => {
  const input = updateOrganizationSchema.parse(req.body);
  ok(res, await orgs.updateCurrentOrganization(currentTenant(req), input));
});
