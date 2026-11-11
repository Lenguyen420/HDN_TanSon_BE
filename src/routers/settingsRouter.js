import { Router } from "express";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { emptySettingsQuery, settingsSchema } from "../dto/settings.dto.js";
import settingsController from "../controllers/settingsController.js";

export default function settingsRouter(services, isPublic = false) {
  const router = Router();
  const controller = settingsController(services.settings);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  if (!isPublic) router.use(authAdmin(services.auth));
  router.get(
    "/",
    validateQuery(emptySettingsQuery),
    isPublic ? controller.getPublic : controller.get,
  );
  if (!isPublic)
    router.put(
      "/",
      validateQuery(emptySettingsQuery),
      validateBody(settingsSchema),
      controller.update,
    );
  return router;
}
