import { Router } from "express";
import memberController from "../controllers/memberController.js";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import {
  memberSchema,
  membersQuery,
  importMembersSchema,
} from "../dto/member.dto.js";
export default function memberRouter(services) {
  const router = Router(),
    controller = memberController(services.members);
  router.use(authAdmin(services.auth));
  router.get("/:id/business-license", async (req, res) =>
    services.members.businessLicense(req.params.id, req, res),
  );
  router.get("/", validateQuery(membersQuery), controller.list);
  router.post("/import", validateBody(importMembersSchema), controller.import);
  router.get("/:id", controller.get);
  router.post("/", validateBody(memberSchema), controller.create);
  router.put("/:id", validateBody(memberSchema), controller.update);
  router.delete("/:id", controller.remove);
  return router;
}
