import { Router, raw } from "express";
import { z } from "zod";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody } from "../middlewares/validateRequest.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import {
  videoChunkSize,
  smallVideoChunkSize,
  maxIntroductionVideoSize,
} from "../services/introductionVideoService.js";
const id = z.string().uuid();
export default function introductionVideoRouter(services) {
  const router = Router(),
    root = "/admin/introduction-videos";
  // A 100 MiB upload needs 400 small chunks. Keep a separate bounded limit
  // for this route, including unauthenticated requests.
  router.use(root, createRateLimiter(600), authAdmin(services.auth));
  router.post(
    root + "/upload",
    (req, res, next) =>
      services.localIntroductionVideos.middleware()(req, res, next),
    async (req, res) => {
      try {
        const video = await services.localIntroductionVideos.finish(req.file);
        await services.settings.update(
          { introductionVideoUrl: video.url },
          req.user.id,
        );
        res.set("Cache-Control", "no-store").status(201).json({ data: video });
      } catch (error) {
        await services.localIntroductionVideos.discard(req.file);
        throw error;
      }
    },
  );
  // Legacy chunk routes remain compatible with existing clients and stored videos.
  router.post(
    root,
    validateBody(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        size: z.number().int().min(12).max(maxIntroductionVideoSize),
        chunkSize: z
          .union([z.literal(smallVideoChunkSize), z.literal(videoChunkSize)])
          .optional(),
      }),
    ),
    async (req, res) =>
      res
        .status(201)
        .json(await services.introductionVideos.create(req.body, req.user.id)),
  );
  router.put(
    root + "/:id/chunks/:index",
    raw({ type: "application/octet-stream", limit: videoChunkSize }),
    async (req, res) =>
      res.json(
        await services.introductionVideos.putPart(
          id.parse(req.params.id),
          z.coerce.number().int().min(0).parse(req.params.index),
          req.body,
          req.user.id,
        ),
      ),
  );
  router.post(root + "/:id/complete", async (req, res) =>
    res.json(
      await services.introductionVideos.complete(
        id.parse(req.params.id),
        req.user.id,
      ),
    ),
  );
  router.delete(root + "/:id", async (req, res) =>
    res.json(
      await services.introductionVideos.cancel(
        id.parse(req.params.id),
        req.user.id,
      ),
    ),
  );
  router.get("/public/introduction-videos/:id", async (req, res) => {
    const parsed = id.safeParse(req.params.id);
    if (!parsed.success) return res.status(404).end();
    await services.introductionVideos.serve(parsed.data, req, res);
  });
  return router;
}
