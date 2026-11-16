import { Router } from "express";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { idSchema } from "../dto/member.dto.js";
import {
  partnerSchema,
  partnerPatch,
  contributionSchema,
  contributionPatch,
  partnerQuery,
  publicPartnerQuery,
  historyQuery,
  statisticsQuery,
} from "../dto/partner.dto.js";
export default function partnerRouter(services) {
  const router = Router(),
    admin = Router(),
    service = services.partners;
  const id = (req) => idSchema.parse(req.params.id);
  const noStore = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };
  router.get(
    ["/partners", "/public/partners"],
    noStore,
    validateQuery(publicPartnerQuery),
    async (req, res) => res.json(await service.list(res.locals.query)),
  );
  router.get(
    ["/partners/:id", "/public/partners/:id"],
    noStore,
    validateQuery(historyQuery),
    async (req, res) =>
      res.json(await service.detail(id(req), res.locals.query)),
  );
  admin.use(["/partners", "/contributions"], noStore, authAdmin(services.auth));
  admin.get(
    "/partners/statistics",
    validateQuery(statisticsQuery),
    async (req, res) =>
      res.json({ data: await service.statistics(res.locals.query, true) }),
  );
  admin.get("/partners", validateQuery(partnerQuery), async (req, res) =>
    res.json(await service.list(res.locals.query, true)),
  );
  admin.get("/partners/:id", validateQuery(historyQuery), async (req, res) =>
    res.json(await service.detail(id(req), res.locals.query, true)),
  );
  admin.post("/partners", validateBody(partnerSchema), async (req, res) =>
    res
      .status(201)
      .json(await service.create("partner", req.body, req.user.id)),
  );
  admin.patch("/partners/:id", validateBody(partnerPatch), async (req, res) =>
    res.json(await service.update("partner", id(req), req.body, req.user.id)),
  );
  admin.delete("/partners/:id", async (req, res) =>
    res.json(await service.update("partner", id(req), {}, req.user.id, true)),
  );
  admin.post(
    "/partners/:id/contributions",
    validateBody(contributionSchema),
    async (req, res) =>
      res
        .status(201)
        .json(
          await service.create("contribution", req.body, req.user.id, id(req)),
        ),
  );
  admin.patch(
    "/contributions/:id",
    validateBody(contributionPatch),
    async (req, res) =>
      res.json(
        await service.update("contribution", id(req), req.body, req.user.id),
      ),
  );
  admin.delete("/contributions/:id", async (req, res) =>
    res.json(
      await service.update("contribution", id(req), {}, req.user.id, true),
    ),
  );
  router.use("/admin", admin);
  return router;
}
