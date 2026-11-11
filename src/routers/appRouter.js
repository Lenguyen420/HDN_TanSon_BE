import { Router } from "express";
import authRouter from "./authRouter.js";
import memberRouter from "./memberRouter.js";
import registrationRouter, {
  publicRegistrationRouter,
} from "./registrationRouter.js";
import healthController from "../controllers/healthController.js";
export default function appRouter(services) {
  const router = Router();
  router.get("/health", healthController);
  router.use("/auth", authRouter(services));
  router.use("/admin/members", memberRouter(services));
  router.use("/admin/registrations", registrationRouter(services));
  router.use("/public/registrations", publicRegistrationRouter(services));
  return router;
}
