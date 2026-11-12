import { Router } from "express";
import { z } from "zod";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { baseQuery, idSchema, text } from "../dto/member.dto.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
const token = z.string().regex(/^[a-f0-9]{64}$/);
export default function eventAttendanceRouter(services) {
  const router = Router();
  const root = "/public/events/:id/check-in";
  router.use(root, createRateLimiter(30), (req, res, next) => {
    res.set("Cache-Control", "no-store");
    idSchema.parse(req.params.id);
    next();
  });
  router.get(root, async (req, res) =>
    res.json(
      await services.eventAttendance.status(
        req.params.id,
        token.parse(req.get("X-Attendance-Token")),
      ),
    ),
  );
  router.post(
    root,
    validateBody(
      z.strictObject({
        token,
        name: text(150).min(1),
        company: text(250).default(""),
      }),
    ),
    async (req, res) =>
      res.json(await services.eventAttendance.checkIn(req.params.id, req.body)),
  );
  router.get(
    "/admin/events/:id/attendance",
    authAdmin(services.auth),
    validateQuery(z.strictObject(baseQuery)),
    async (req, res) => {
      idSchema.parse(req.params.id);
      res.json(
        await services.eventAttendance.list(req.params.id, res.locals.query),
      );
    },
  );
  return router;
}
