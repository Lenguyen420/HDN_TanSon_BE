import { Router } from "express";
import registrationController from "../controllers/registrationController.js";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import {
  registrationSchema,
  publicRegistrationSchema,
  registrationsQuery,
  importRegistrationsSchema,
  rejectSchema,
  approveSchema,
} from "../dto/registration.dto.js";
export default function registrationRouter(services) {
  const router = Router(),
    controller = registrationController(services.registrations);
  router.use(authAdmin(services.auth));
  router.get("/", validateQuery(registrationsQuery), controller.list);
  router.post(
    "/import",
    validateBody(importRegistrationsSchema),
    controller.import,
  );
  router.get("/:id", controller.get);
  router.post("/", validateBody(registrationSchema), controller.create);
  router.put("/:id", validateBody(registrationSchema), controller.update);
  router.delete("/:id", controller.remove);
  router.post("/:id/approve", validateBody(approveSchema), controller.approve);
  router.post("/:id/reject", validateBody(rejectSchema), controller.reject);
  return router;
}
export function publicRegistrationRouter(services) {
  const router = Router();
  router.post(
    "/",
    createRateLimiter(5),
    validateBody(publicRegistrationSchema),
    registrationController(services.registrations).submitPublic,
  );
  return router;
}
