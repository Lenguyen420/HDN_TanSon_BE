import { Router } from "express";
import authAdmin from "../middlewares/authAdmin.js";
import authLocalGo from "../middlewares/authLocalGo.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as dto from "../dto/localgo.dto.js";

export default function localgoRouter(services) {
  const router = Router(),
    c = services.localgo;
  const auth = authLocalGo(services),
    admin = authAdmin(services.auth);
  const writeLimit = createRateLimiter(30);
  const actor = (res) => res.locals.localgoActor;
  const id = (req) => dto.idSchema.parse(req.params.id);
  router.use(["/localgo", "/admin/localgo"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/localgo/categories", async (req, res) =>
    res.json({ data: await c.listCategories() }),
  );
  router.get(
    "/localgo/places",
    validateQuery(dto.placesQuery),
    async (req, res) => res.json(await c.list(res.locals.query)),
  );
  router.get(
    "/localgo/my-places",
    auth,
    validateQuery(dto.placesQuery),
    async (req, res) =>
      res.json(await c.list(res.locals.query, actor(res), "mine")),
  );
  router.get("/localgo/places/:id/manage", auth, async (req, res) =>
    res.json(await c.get(id(req), actor(res), true)),
  );
  router.get("/localgo/places/:id", async (req, res) =>
    res.json(await c.get(id(req))),
  );
  router.post(
    "/localgo/places",
    auth,
    writeLimit,
    validateBody(dto.placeCreate),
    async (req, res) =>
      res.status(201).json(await c.create(req.body, actor(res))),
  );
  router.patch(
    "/localgo/places/:id",
    auth,
    writeLimit,
    validateBody(dto.placePatch),
    async (req, res) => res.json(await c.update(id(req), req.body, actor(res))),
  );
  router.patch(
    "/localgo/places/:id/visibility",
    auth,
    writeLimit,
    validateBody(dto.visibility),
    async (req, res) =>
      res.json(
        await c.update(
          id(req),
          { isVisible: req.body.isVisible },
          actor(res),
          "visibility",
          req.body.reason,
        ),
      ),
  );
  router.delete("/localgo/places/:id", auth, writeLimit, async (req, res) => {
    await c.remove(id(req), actor(res));
    res.status(204).end();
  });
  router.use("/admin/localgo", admin);
  router.get("/admin/localgo/categories", async (req, res) =>
    res.json({ data: await c.listCategories() }),
  );
  router.post(
    "/admin/localgo/categories",
    writeLimit,
    validateBody(dto.categoryCreate),
    async (req, res) =>
      res.status(201).json({ data: await c.createCategory(req.body) }),
  );
  router.patch(
    "/admin/localgo/categories/:code",
    writeLimit,
    validateBody(dto.categoryPatch),
    async (req, res) =>
      res.json({
        data: await c.updateCategory(
          dto.categoryCode.parse(req.params.code),
          req.body,
        ),
      }),
  );
  router.delete(
    "/admin/localgo/categories/:code",
    writeLimit,
    async (req, res) => {
      await c.removeCategory(dto.categoryCode.parse(req.params.code));
      res.status(204).end();
    },
  );
  router.get(
    "/admin/localgo/places",
    validateQuery(dto.placesQuery),
    async (req, res) =>
      res.json(await c.list(res.locals.query, req.user, "admin")),
  );
  router.get("/admin/localgo/places/:id", async (req, res) =>
    res.json(await c.get(id(req), req.user, true)),
  );
  router.patch(
    "/admin/localgo/places/:id/hide",
    writeLimit,
    validateBody(dto.hidePlace),
    async (req, res) => {
      const reason = req.body.reason.trim();
      res.json(
        await c.update(id(req), { isVisible: false }, req.user, "hide", reason),
      );
    },
  );
  return router;
}
