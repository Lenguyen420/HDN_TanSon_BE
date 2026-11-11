import { Router } from "express";
import authController from "../controllers/authController.js";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody } from "../middlewares/validateRequest.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import { loginSchema, refreshSchema } from "../dto/auth.dto.js";
export default function authRouter(services) {
  const router = Router(),
    controller = authController(services.auth);
  router.post(
    "/admin-login",
    createRateLimiter(10),
    validateBody(loginSchema),
    controller.login,
  );
  router.post("/refresh", validateBody(refreshSchema), controller.refresh);
  router.post("/logout", validateBody(refreshSchema), controller.logout);
  router.get("/me", authAdmin(services.auth), controller.me);
  return router;
}
