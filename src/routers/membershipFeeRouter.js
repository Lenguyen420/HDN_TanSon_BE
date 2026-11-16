import { Router } from "express";
import { z } from "zod";
import authAdmin from "../middlewares/authAdmin.js";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { baseQuery, idSchema } from "../dto/member.dto.js";
import {
  campaignSchema,
  campaignPatch,
  campaignQuery,
  duesQuery,
  proofSchema,
  manualPaymentSchema,
  decisionSchema,
} from "../dto/membershipFee.dto.js";

import { createRateLimiter } from "../middlewares/rateLimit.js";
export default function membershipFeeRouter(services) {
  const router = Router(),
    fees = services.membershipFees,
    admin = Router(),
    member = Router();
  const id = (req) => idSchema.parse(req.params.id);
  const noStore = (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  };
  admin.use(
    ["/membership-fees", "/membership-fee-dues", "/membership-fee-payments"],
    noStore,
    authAdmin(services.auth),
  );
  admin.get(
    "/membership-fees",
    validateQuery(campaignQuery),
    async (req, res) => res.json(await fees.list(res.locals.query)),
  );
  admin.post(
    "/membership-fees",
    validateBody(campaignSchema),
    async (req, res) =>
      res.status(201).json(await fees.create(req.body, req.user.id)),
  );
  admin.patch(
    "/membership-fees/:id",
    validateBody(campaignPatch),
    async (req, res) =>
      res.json(await fees.update(id(req), req.body, req.user.id)),
  );
  admin.post(
    "/membership-fees/:id/publish",
    validateBody(z.strictObject({})),
    async (req, res) => res.json(await fees.publish(id(req), req.user.id)),
  );
  admin.get(
    "/membership-fees/:id/dues",
    validateQuery(duesQuery),
    async (req, res) =>
      res.json(await fees.listDues(id(req), res.locals.query)),
  );
  admin.post(
    "/membership-fee-dues/:id/manual-payment",
    validateBody(manualPaymentSchema),
    async (req, res) =>
      res.status(201).json(await fees.manual(id(req), req.body, req.user.id)),
  );
  for (const action of ["confirm", "reject"])
    admin.post(
      "/membership-fee-payments/:id/" + action,
      validateBody(decisionSchema),
      async (req, res) =>
        res.json(
          await fees.decide(
            id(req),
            action === "confirm",
            req.body,
            req.user.id,
          ),
        ),
    );
  member.use(noStore, createRateLimiter(60));
  member.post(
    "/session",
    createRateLimiter(20),
    validateBody(
      z.strictObject({
        tokens: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .min(1)
          .max(20),
      }),
    ),
    async (req, res) => {
      res.json({
        data: await services.membershipFeeAuth.session(req.body.tokens),
      });
    },
  );
  member.use(async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const member = await services.membershipFeeAuth.authenticate(token);
    res.locals.memberId = member._id;
    next();
  });
  member.get(
    "/my-dues",
    validateQuery(z.strictObject(baseQuery)),
    async (req, res) =>
      res.json(await fees.myDues(res.locals.memberId, res.locals.query)),
  );
  member.get("/my-dues/:id", async (req, res) =>
    res.json(await fees.myDue(id(req), res.locals.memberId)),
  );
  member.post(
    "/my-dues/:id/payment-proof",
    validateBody(proofSchema),
    async (req, res) =>
      res
        .status(201)
        .json(await fees.submit(id(req), res.locals.memberId, req.body)),
  );
  router.use("/admin", admin);
  router.use("/membership-fees", member);
  return router;
}
