import { Router } from "express";
import { ok } from "../../lib/respond.ts";
import { listMembersSchema } from "./members.schemas.ts";
import * as members from "./members.service.ts";

export const membersTestRouter = Router();
membersTestRouter.get("/view-all-members", async (req, res) => {
  const result = await members.listMembers(listMembersSchema.parse(req.query));
  ok(res, result.rows, result.meta);
});
