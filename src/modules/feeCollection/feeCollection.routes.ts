import { Router } from 'express';
import { z } from 'zod';
import { parseId } from '../../lib/bigint';
import { created, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import * as svc from './feeCollection.service';
import * as student from './feeStudent.service';

// ---- /api/fee-collection
export const feeCollectionRouter = Router();

const submitPaymentSchema = z
  .object({
    amount: z.coerce.number().positive().max(10_000_000),
    // the UPI transaction / reference number shown in GPay after paying
    referenceNo: z.string().trim().regex(/^[A-Za-z0-9]{10,22}$/, 'Enter the UPI reference number from GPay'),
  })
  .strict();

// Fee structures with their class name, amounts and total (for the admin screen).
feeCollectionRouter.get('/structures', requirePermission('finance.view'), async (req, res) => {
  ok(res, await svc.listStructuresWithAmounts(currentTenant(req)));
});

// "Update": bill every student of the structure's class (safe to run again).
feeCollectionRouter.post('/structures/:id/publish', requirePermission('finance.edit'), async (req, res) => {
  ok(res, await svc.publishStructure(currentTenant(req), parseId(req.params.id)));
});

// ---- the signed-in student (own login only, no permission needed)
feeCollectionRouter.get('/me', async (req, res) => {
  ok(res, await student.getMyFees(currentTenant(req), currentUser(req)));
});

feeCollectionRouter.post('/me/payments', async (req, res) => {
  created(res, await student.submitMyPayment(currentTenant(req), currentUser(req), submitPaymentSchema.parse(req.body)));
});

// ---- admin: payments waiting to be checked
feeCollectionRouter.get('/payments/pending', requirePermission('finance.view'), async (req, res) => {
  ok(res, await student.listPendingPayments(currentTenant(req)));
});

feeCollectionRouter.post('/payments/:id/approve', requirePermission('finance.edit'), async (req, res) => {
  ok(res, await student.reviewPayment(currentTenant(req), parseId(req.params.id), 'approve'));
});

feeCollectionRouter.post('/payments/:id/reject', requirePermission('finance.edit'), async (req, res) => {
  ok(res, await student.reviewPayment(currentTenant(req), parseId(req.params.id), 'reject'));
});

// ---- extra route on /api/fee-structures/:id/publish (the "Update" button of the Fee Structures screen)
export const feeStructurePublishRouter = Router();

feeStructurePublishRouter.post('/:id/publish', requirePermission('finance.edit'), async (req, res) => {
  ok(res, await svc.publishStructure(currentTenant(req), parseId(req.params.id)));
});