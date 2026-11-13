import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createFeeAssignmentSchema,
  createFeeGroupSchema,
  createFeeStructureSchema,
  createFeeTypeSchema,
  createInvoiceSchema,
  createPaymentSchema,
  feeInstallmentInputSchema,
  feeStructureItemInputSchema,
  generateInvoiceFromStructureSchema,
  invoiceLineInputSchema,
  listFeeAssignmentsSchema,
  listFeeGroupsSchema,
  listFeeStructuresSchema,
  listFeeTypesSchema,
  listInvoicesSchema,
  listPaymentsSchema,
  updateFeeAssignmentSchema,
  updateFeeGroupSchema,
  updateFeeInstallmentSchema,
  updateFeeStructureItemSchema,
  updateFeeStructureSchema,
  updateFeeTypeSchema,
  updateInvoiceSchema,
  updatePaymentSchema,
} from './finance.schemas';
import * as service from './finance.service';

// ================================================================ /api/fee-groups
export const feeGroupsRouter = Router();

feeGroupsRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listFeeGroupsSchema.parse(req.query);
  const { rows, meta } = await service.listFeeGroups(currentTenant(req), query);
  ok(res, rows, meta);
});

feeGroupsRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getFeeGroup(currentTenant(req), parseId(req.params.id)));
});

feeGroupsRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createFeeGroupSchema.parse(req.body);
  created(res, await service.createFeeGroup(currentTenant(req), body));
});

feeGroupsRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updateFeeGroupSchema.parse(req.body);
  ok(res, await service.updateFeeGroup(currentTenant(req), parseId(req.params.id), body));
});

feeGroupsRouter.delete('/:id', requirePermission('finance.delete'), async (req, res) => {
  await service.deleteFeeGroup(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/fee-types
export const feeTypesRouter = Router();

feeTypesRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listFeeTypesSchema.parse(req.query);
  const { rows, meta } = await service.listFeeTypes(currentTenant(req), query);
  ok(res, rows, meta);
});

feeTypesRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getFeeType(currentTenant(req), parseId(req.params.id)));
});

feeTypesRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createFeeTypeSchema.parse(req.body);
  created(res, await service.createFeeType(currentTenant(req), body));
});

feeTypesRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updateFeeTypeSchema.parse(req.body);
  ok(res, await service.updateFeeType(currentTenant(req), parseId(req.params.id), body));
});

feeTypesRouter.delete('/:id', requirePermission('finance.delete'), async (req, res) => {
  await service.deleteFeeType(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/fee-structures
export const feeStructuresRouter = Router();

feeStructuresRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listFeeStructuresSchema.parse(req.query);
  const { rows, meta } = await service.listFeeStructures(currentTenant(req), query);
  ok(res, rows, meta);
});

feeStructuresRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getFeeStructure(currentTenant(req), parseId(req.params.id)));
});

feeStructuresRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createFeeStructureSchema.parse(req.body);
  created(res, await service.createFeeStructure(currentTenant(req), body));
});

feeStructuresRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updateFeeStructureSchema.parse(req.body);
  ok(res, await service.updateFeeStructure(currentTenant(req), parseId(req.params.id), body));
});

feeStructuresRouter.delete('/:id', requirePermission('finance.delete'), async (req, res) => {
  await service.deleteFeeStructure(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

feeStructuresRouter.post('/:id/items', requirePermission('finance.edit'), async (req, res) => {
  const body = feeStructureItemInputSchema.parse(req.body);
  created(res, await service.addFeeStructureItem(currentTenant(req), parseId(req.params.id), body));
});

feeStructuresRouter.patch('/:id/items/:itemId', requirePermission('finance.edit'), async (req, res) => {
  const body = updateFeeStructureItemSchema.parse(req.body);
  ok(
    res,
    await service.updateFeeStructureItem(
      currentTenant(req),
      parseId(req.params.id),
      parseId(req.params.itemId),
      body,
    ),
  );
});

feeStructuresRouter.delete('/:id/items/:itemId', requirePermission('finance.edit'), async (req, res) => {
  await service.deleteFeeStructureItem(currentTenant(req), parseId(req.params.id), parseId(req.params.itemId));
  noContent(res);
});

feeStructuresRouter.post('/:id/installments', requirePermission('finance.edit'), async (req, res) => {
  const body = feeInstallmentInputSchema.parse(req.body);
  created(res, await service.addFeeInstallment(currentTenant(req), parseId(req.params.id), body));
});

feeStructuresRouter.patch(
  '/:id/installments/:installmentId',
  requirePermission('finance.edit'),
  async (req, res) => {
    const body = updateFeeInstallmentSchema.parse(req.body);
    ok(
      res,
      await service.updateFeeInstallment(
        currentTenant(req),
        parseId(req.params.id),
        parseId(req.params.installmentId),
        body,
      ),
    );
  },
);

feeStructuresRouter.delete(
  '/:id/installments/:installmentId',
  requirePermission('finance.edit'),
  async (req, res) => {
    await service.deleteFeeInstallment(currentTenant(req), parseId(req.params.id), parseId(req.params.installmentId));
    noContent(res);
  },
);

// ================================================================ /api/fee-assignments
export const feeAssignmentsRouter = Router();

feeAssignmentsRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listFeeAssignmentsSchema.parse(req.query);
  const { rows, meta } = await service.listFeeAssignments(currentTenant(req), query);
  ok(res, rows, meta);
});

feeAssignmentsRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getFeeAssignment(currentTenant(req), parseId(req.params.id)));
});

feeAssignmentsRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createFeeAssignmentSchema.parse(req.body);
  created(res, await service.createFeeAssignment(currentTenant(req), body));
});

feeAssignmentsRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updateFeeAssignmentSchema.parse(req.body);
  ok(res, await service.updateFeeAssignment(currentTenant(req), parseId(req.params.id), body));
});

feeAssignmentsRouter.delete('/:id', requirePermission('finance.delete'), async (req, res) => {
  await service.deleteFeeAssignment(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/invoices
export const invoicesRouter = Router();

invoicesRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listInvoicesSchema.parse(req.query);
  const { rows, meta } = await service.listInvoices(currentTenant(req), currentUser(req), query);
  ok(res, rows, meta);
});

invoicesRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getInvoice(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

invoicesRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createInvoiceSchema.parse(req.body);
  created(res, await service.createInvoice(currentTenant(req), body));
});

invoicesRouter.post(
  '/generate-from-structure',
  requirePermission('finance.create'),
  async (req, res) => {
    const body = generateInvoiceFromStructureSchema.parse(req.body);
    created(res, await service.generateInvoiceFromStructure(currentTenant(req), body));
  },
);

invoicesRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updateInvoiceSchema.parse(req.body);
  ok(res, await service.updateInvoice(currentTenant(req), parseId(req.params.id), body));
});

invoicesRouter.post('/:id/lines', requirePermission('finance.edit'), async (req, res) => {
  const body = invoiceLineInputSchema.parse(req.body);
  created(res, await service.addInvoiceLine(currentTenant(req), parseId(req.params.id), body));
});

invoicesRouter.delete('/:id/lines/:lineId', requirePermission('finance.edit'), async (req, res) => {
  await service.deleteInvoiceLine(currentTenant(req), parseId(req.params.id), parseId(req.params.lineId));
  noContent(res);
});

// ================================================================ /api/payments
export const paymentsRouter = Router();

paymentsRouter.get('/', requirePermission('finance.view'), async (req, res) => {
  const query = listPaymentsSchema.parse(req.query);
  const { rows, meta } = await service.listPayments(currentTenant(req), currentUser(req), query);
  ok(res, rows, meta);
});

paymentsRouter.get('/:id', requirePermission('finance.view'), async (req, res) => {
  ok(res, await service.getPayment(currentTenant(req), currentUser(req), parseId(req.params.id)));
});

paymentsRouter.post('/', requirePermission('finance.create'), async (req, res) => {
  const body = createPaymentSchema.parse(req.body);
  const { row, replayed } = await service.createPayment(currentTenant(req), currentUser(req), body);
  if (replayed) ok(res, row);
  else created(res, row);
});

paymentsRouter.patch('/:id', requirePermission('finance.edit'), async (req, res) => {
  const body = updatePaymentSchema.parse(req.body);
  ok(res, await service.updatePayment(currentTenant(req), parseId(req.params.id), body));
});
