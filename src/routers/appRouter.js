import introductionVideoRouter from "./introductionVideoRouter.js";
import eventAttendanceRouter from "./eventAttendanceRouter.js";
import { membersQuery } from "../dto/member.dto.js";
import { validateQuery } from "../middlewares/validateRequest.js";
import { Router } from "express";
import eventFileRouter from "./eventFileRouter.js";
import authRouter from "./authRouter.js";
import zaloOAuthRouter from "./zaloOAuthRouter.js";
import zaloSdkProfileRouter from "./zaloSdkProfileRouter.js";
import registrationNotificationRouter from "./registrationNotificationRouter.js";
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
  router.use(introductionVideoRouter(services));
  router.use(eventFileRouter(services));
  router.get("/health", healthController);
  router.use(eventAttendanceRouter(services));
  router.use(registrationNotificationRouter(services));
  router.use("/auth", authRouter(services));
  router.use("/auth/zalo", zaloOAuthRouter(services));
  router.use("/admin/members", memberRouter(services));
  router.use("/member", memberAccessRouter(services));
  router.use("/public/zalo-profiles", zaloSdkProfileRouter(services));
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
