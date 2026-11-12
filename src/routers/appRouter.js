import { membersQuery } from "../dto/member.dto.js";
import { validateQuery } from "../middlewares/validateRequest.js";
import { Router } from "express";
import authRouter from "./authRouter.js";
import zaloOAuthRouter from "./zaloOAuthRouter.js";
import memberRouter from "./memberRouter.js";
import memberAccessRouter from "./memberAccessRouter.js";
import registrationRouter, {
  publicRegistrationRouter,
} from "./registrationRouter.js";
import healthController from "../controllers/healthController.js";
import contentRouter from "./contentRouter.js";
import { contentDefinitions } from "../dto/content.dto.js";
import settingsRouter from "./settingsRouter.js";
export default function appRouter(services) {
  const router = Router();
  router.get("/health", healthController);
  router.use("/auth", authRouter(services));
  router.use("/auth/zalo", zaloOAuthRouter(services));
  router.use("/admin/members", memberRouter(services));
  router.use("/member", memberAccessRouter(services));
  router.get(
    "/public/members",
    validateQuery(membersQuery),
    async (req, res) => {
      res.json(await services.memberAccess.directory(res.locals.query));
    },
  );
  router.use("/admin/registrations", registrationRouter(services));
  router.use("/public/registrations", publicRegistrationRouter(services));
  router.use("/admin/settings", settingsRouter(services));
  router.use("/public/settings", settingsRouter(services, true));
  for (const [collection, definition] of Object.entries(contentDefinitions)) {
    router.use(
      `/admin/${collection}`,
      contentRouter(services, collection, definition),
    );
    router.use(
      `/public/${collection}`,
      contentRouter(services, collection, definition, true),
    );
  }
  return router;
}
