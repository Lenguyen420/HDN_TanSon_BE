import { Router } from "express";
import { z } from "zod";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { baseQuery } from "../dto/member.dto.js";
import { selfProfileSchema } from "../dto/registration.dto.js";
import { idSchema } from "../dto/member.dto.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";

export default function registrationNotificationRouter(services) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/admin/registration-inbox",
    authAdmin(services.auth),
    validateQuery(z.strictObject(baseQuery)),
    async (req, res) =>
      res.json(
        await services.registrationNotifications.admin(res.locals.query),
      ),
  );
  router.post(
    "/public/registration-notifications",
    createRateLimiter(30),
    validateBody(
      z.strictObject({
        tokens: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),
      }),
    ),
    async (req, res) =>
      res.json(
        await services.registrationNotifications.applicant(req.body.tokens),
      ),
  );
  router.put(
    "/public/registration-profile/:id",
    createRateLimiter(10),
    validateBody(selfProfileSchema),
    async (req, res) => {
      const id = idSchema.parse(req.params.id);
      res.json(
        await services.registrationNotifications.updateProfile(id, req.body),
      );
    },
  );
  return router;
}
