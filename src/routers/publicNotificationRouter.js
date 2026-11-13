import { Router } from "express";
import { z } from "zod";
import { baseQuery } from "../dto/member.dto.js";
import { validateQuery } from "../middlewares/validateRequest.js";

export default function publicNotificationRouter(services) {
  const router = Router();
  router.get(
    "/public/notification-feed",
    validateQuery(
      z.strictObject({
        ...baseQuery,
        source: z
          .enum(["announcement", "news", "events", "company-anniversary"])
          .optional(),
      }),
    ),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      res.json(await services.publicNotifications.list(res.locals.query));
    },
  );
  return router;
}
