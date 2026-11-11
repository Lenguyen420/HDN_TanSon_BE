import { Router } from "express";
import contentController from "../controllers/contentController.js";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { idSchema } from "../dto/member.dto.js";

export default function contentRouter(
  services,
  collection,
  definition,
  isPublic = false,
) {
  const router = Router();
  const controller = contentController(services.content[collection], isPublic);
  if (!isPublic) router.use(authAdmin(services.auth));
  router.param("id", (req, res, next, id) => {
    const result = idSchema.safeParse(id);
    next(result.success ? undefined : result.error);
  });
  router.get(
    "/",
    validateQuery(isPublic ? definition.publicQuery : definition.query),
    controller.list,
  );
  router.get("/:id", controller.get);
  if (!isPublic) {
    router.post("/", validateBody(definition.body), controller.create);
    router.put("/:id", validateBody(definition.body), controller.update);
    router.delete("/:id", controller.remove);
  }
  return router;
}
