import { Router } from "express";
import { z } from "zod";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import { validateBody } from "../middlewares/validateRequest.js";

const schema = z.strictObject({
  zaloUserId: z.string().regex(/^\d{1,100}$/),
  name: z.string().trim().min(1).max(150),
  avatar: z.union([
    z.literal(""),
    z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }),
  ]),
});

export default function zaloSdkProfileRouter(services) {
  const router = Router();
  router.use(createRateLimiter(10));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.post("/", validateBody(schema), async (req, res) => {
    res.json({ data: await services.zaloSdkProfiles.save(req.body) });
  });
  return router;
}
