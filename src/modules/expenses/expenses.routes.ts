import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import {
  createExpenseCategorySchema,
  createExpenseSchema,
  decideExpenseSchema,
  listExpenseCategoriesSchema,
  listExpensesSchema,
  markExpensePaidSchema,
  updateExpenseCategorySchema,
  updateExpenseSchema,
} from './expenses.schemas';
import * as service from './expenses.service';

// ================================================================ /api/expense-categories
export const expenseCategoriesRouter = Router();

expenseCategoriesRouter.get('/', requirePermission('expenses.view'), async (req, res) => {
  const query = listExpenseCategoriesSchema.parse(req.query);
  const { rows, meta } = await service.listExpenseCategories(currentTenant(req), query);
  ok(res, rows, meta);
});

expenseCategoriesRouter.get('/:id', requirePermission('expenses.view'), async (req, res) => {
  ok(res, await service.getExpenseCategory(currentTenant(req), parseId(req.params.id)));
});

expenseCategoriesRouter.post('/', requirePermission('expenses.create'), async (req, res) => {
  const body = createExpenseCategorySchema.parse(req.body);
  created(res, await service.createExpenseCategory(currentTenant(req), body));
});

expenseCategoriesRouter.patch('/:id', requirePermission('expenses.edit'), async (req, res) => {
  const body = updateExpenseCategorySchema.parse(req.body);
  ok(res, await service.updateExpenseCategory(currentTenant(req), parseId(req.params.id), body));
});

expenseCategoriesRouter.delete('/:id', requirePermission('expenses.delete'), async (req, res) => {
  await service.deleteExpenseCategory(currentTenant(req), parseId(req.params.id));
  noContent(res);
});

// ================================================================ /api/expenses
export const expensesRouter = Router();

expensesRouter.get('/', requirePermission('expenses.view'), async (req, res) => {
  const query = listExpensesSchema.parse(req.query);
  const { rows, meta } = await service.listExpenses(currentTenant(req), query);
  ok(res, rows, meta);
});

expensesRouter.get('/:id', requirePermission('expenses.view'), async (req, res) => {
  ok(res, await service.getExpense(currentTenant(req), parseId(req.params.id)));
});

expensesRouter.post('/', requirePermission('expenses.create'), async (req, res) => {
  const body = createExpenseSchema.parse(req.body);
  created(res, await service.createExpense(currentTenant(req), body));
});

expensesRouter.patch('/:id', requirePermission('expenses.edit'), async (req, res) => {
  const body = updateExpenseSchema.parse(req.body);
  ok(res, await service.updateExpense(currentTenant(req), parseId(req.params.id), body));
});

expensesRouter.post('/:id/decide', requirePermission('expenses.approve'), async (req, res) => {
  const body = decideExpenseSchema.parse(req.body);
  ok(res, await service.decideExpense(currentTenant(req), currentUser(req), parseId(req.params.id), body));
});

expensesRouter.post('/:id/mark-paid', requirePermission('expenses.approve'), async (req, res) => {
  const body = markExpensePaidSchema.parse(req.body ?? {});
  ok(res, await service.markExpensePaid(currentTenant(req), parseId(req.params.id), body));
});

expensesRouter.delete('/:id', requirePermission('expenses.delete'), async (req, res) => {
  await service.deleteExpense(currentTenant(req), parseId(req.params.id));
  noContent(res);
});
