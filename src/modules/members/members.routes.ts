import { Router } from 'express';
import { parseId } from '../../lib/bigint';
import { created, noContent, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { addMemberSchema, listMembersSchema, updateMemberSchema } from './members.schemas';
import * as members from './members.service';

export const membersRouter = Router();

membersRouter.get('/', requirePermission('members.view'), async (req, res) => {
  const result = await members.listMembers(currentTenant(req), listMembersSchema.parse(req.query));
  ok(res, result.rows, result.meta); // meta = { page, limit, total, pages }: what the frontend's toPaginated reads
});

membersRouter.post('/', requirePermission('members.create'), async (req, res) => {
  created(res, await members.addMember(currentTenant(req), currentUser(req), addMemberSchema.parse(req.body)));
});

membersRouter.patch('/:id', requirePermission('members.edit'), async (req, res) => {
  const input = updateMemberSchema.parse(req.body);
  ok(res, await members.updateMember(currentTenant(req), currentUser(req), parseId(req.params.id), input));
});

membersRouter.delete('/:id', requirePermission('members.delete'), async (req, res) => {
  await members.removeMember(currentTenant(req), currentUser(req), parseId(req.params.id));
  noContent(res);
});
