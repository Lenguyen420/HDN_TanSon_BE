import { Router } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../middlewares/validateRequest.js";
import { membersQuery } from "../dto/member.dto.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import { HttpError } from "../utils/httpError.js";
import { presentMember } from "../services/memberService.js";

export default function memberAccessRouter(services) {
  const router = Router();
  router.use(createRateLimiter(30));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.post(
    "/session",
    validateBody(
      z.strictObject({ phoneToken: z.string().min(1).max(4096).optional() }),
    ),
    async (req, res) => {
      const header = req.headers.authorization || "";
      const result = await services.memberAccess.session(
        header.startsWith("Bearer ") ? header.slice(7) : "",
        req.body.phoneToken,
      );
      res.json({
        data: {
          ...result,
          member: result.member ? presentMember(result.member) : null,
        },
      });
    },
  );
  router.use(async (req, res, next) => {
    const header = req.headers.authorization || "";
    res.locals.identity = await services.memberAccess.identity(
      header.startsWith("Bearer ") ? header.slice(7) : "",
    );
    next();
  });
  router.get("/identity", (req, res) => {
    const { zaloUserId, member } = res.locals.identity;
    res.json({
      data: {
        zaloUserId,
        linked: Boolean(member),
        member: member ? presentMember(member) : null,
      },
    });
  });
  router.get("/members", validateQuery(membersQuery), async (req, res) => {
    if (!res.locals.identity.member)
      throw new HttpError(
        403,
        "Tài khoản Zalo chưa được liên kết với hồ sơ hội viên đang hoạt động. Vui lòng liên hệ Ban thư ký.",
      );
    res.json(await services.memberAccess.directory(res.locals.query));
  });
  return router;
}
