import { Router, raw } from "express";
import { z } from "zod";
import authAdmin from "../middlewares/authAdmin.js";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import * as dto from "../dto/trade.dto.js";
import {
  fail,
  present,
  ok,
  page,
  seller,
  staff,
} from "../services/tradeShared.js";
import { maxTradeImageBytes } from "../services/tradeMediaService.js";
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(
      400,
      "VALIDATION_ERROR",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n"),
    );
  return result.data;
};
export default function tradeRouter(services) {
  const router = Router(),
    c = services.trade,
    community = c.community,
    admin = authAdmin(services.auth);
  const bearer = (req) =>
    req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
  const auth =
    (optional = false, allowAdmin = false) =>
    async (req, res, next) => {
      try {
        req.tradeActor = await services.tradeAuth.authenticate(
          bearer(req),
          optional,
        );
      } catch (error) {
        if (!allowAdmin) throw error;
        req.tradeActor = {
          ...(await services.auth.authenticate(bearer(req))),
          status: "ACTIVE",
        };
      }
      next();
    };
  const actor = (req) => req.tradeActor || req.user;
  const q = (req) => parse(dto.query, req.query);
  const pid = (req) => parse(dto.uuid, req.params.id);
  const context = (req) => ({
    ip: req.ip,
    userAgent: req.get("user-agent") || "",
  });
  const superAdmin = (req, res, next) => {
    if (req.user.role !== "SUPER_ADMIN")
      fail(
        403,
        "ADMIN_REQUIRED",
        "Chỉ quản trị viên cấp cao được quản lý danh mục.",
      );
    next();
  };
  const writeLimit = createRateLimiter(30),
    reviewLimit = createRateLimiter(10),
    commentLimit = createRateLimiter(10),
    chatOpenLimit = createRateLimiter(30),
    chatLimit = createRateLimiter(60),
    saveLimit = createRateLimiter(60);
  router.use(
    [
      "/trade-posts",
      "/trade-post-categories",
      "/trade-conversations",
      "/trade-media",
      "/trade-session",
      "/reviews",
      "/trade-management",
      "/trade-notifications",
      "/admin/trade-posts",
      "/admin/trade-post-categories",
      "/admin/reviews",
      "/admin/trade-conversations",
      "/admin/trade-users",
      "/admin/trade-notifications",
    ],
    (req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
  );
  router.use(
    [
      "/admin/trade-posts",
      "/admin/trade-post-categories",
      "/admin/reviews",
      "/admin/trade-conversations",
      "/admin/trade-users",
      "/admin/trade-notifications",
    ],
    admin,
  );
  router.post("/trade-session", createRateLimiter(20), async (req, res) => {
    const body = parse(
      z.strictObject({
        tokens: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .min(1)
          .max(20)
          .optional(),
        registrationId: dto.uuid.optional(),
      }),
      req.body,
    );
    res.json(ok(await services.tradeAuth.session(body, bearer(req))));
  });
  router.get("/trade-session", auth(), (req, res) => res.json(ok(actor(req))));
  router.post(
    "/trade-media",
    auth(),
    writeLimit,
    raw({ type: "application/octet-stream", limit: maxTradeImageBytes }),
    async (req, res) =>
      res.status(201).json(await c.mediaService.upload(req.body, actor(req))),
  );
  router.get("/trade-media/:id", async (req, res) =>
    c.mediaService.serve(pid(req), req, res),
  );
  router.delete("/trade-media/:id", auth(), async (req, res) => {
    await c.mediaService.discard(pid(req), actor(req));
    res.status(204).end();
  });
  router.get(
    "/trade-post-categories",
    createRateLimiter(120),
    async (req, res) => res.json(await c.listCategories()),
  );
  router.get("/admin/trade-post-categories", async (req, res) =>
    res.json(await c.listCategories(true)),
  );
  router.get("/admin/trade-post-categories/:id", async (req, res) => {
    const row = await c.categories.findOne({ _id: pid(req), deletedAt: null });
    if (!row)
      fail(404, "TRADE_POST_CATEGORY_NOT_FOUND", "Không tìm thấy danh mục.");
    res.json(ok(present(row)));
  });
  router.post(
    "/admin/trade-post-categories",
    superAdmin,
    writeLimit,
    async (req, res) =>
      res
        .status(201)
        .json(
          await c.createCategory(parse(dto.categoryCreate, req.body), req.user),
        ),
  );
  router.patch(
    "/admin/trade-post-categories/reorder",
    superAdmin,
    writeLimit,
    async (req, res) =>
      res.json(await c.reorder(parse(dto.reorder, req.body).items, req.user)),
  );
  router.patch(
    "/admin/trade-post-categories/:id/status",
    superAdmin,
    writeLimit,
    async (req, res) =>
      res.json(
        await c.updateCategory(
          pid(req),
          parse(
            z.strictObject({
              version: z.number().int().min(1),
              isActive: z.boolean(),
            }),
            req.body,
          ),
          req.user,
        ),
      ),
  );
  router.patch(
    "/admin/trade-post-categories/:id",
    superAdmin,
    writeLimit,
    async (req, res) =>
      res.json(
        await c.updateCategory(
          pid(req),
          parse(dto.categoryPatch, req.body),
          req.user,
        ),
      ),
  );
  router.delete(
    "/admin/trade-post-categories/:id",
    superAdmin,
    writeLimit,
    async (req, res) => {
      await c.deleteCategory(pid(req), req.user);
      res.status(204).end();
    },
  );
  router.get("/trade-posts", auth(true), async (req, res) =>
    res.json(await c.list(q(req), actor(req))),
  );
  router.post("/trade-posts", auth(), async (req, res) =>
    res
      .status(201)
      .json(await c.create(parse(dto.postCreate, req.body), actor(req))),
  );
  router.get("/trade-posts/me", auth(), async (req, res) =>
    res.json(await c.list(q(req), actor(req), "mine")),
  );
  router.get("/trade-posts/me/saved", auth(), async (req, res) =>
    res.json(await c.list(q(req), actor(req), "saved")),
  );
  router.get("/trade-posts/me/analytics", auth(), async (req, res) => {
    seller(actor(req));
    res.json(await c.analytics.summary(q(req), actor(req)));
  });
  router.get("/trade-posts/:id/manage", auth(false, true), async (req, res) =>
    res.json(await c.get(pid(req), actor(req), true)),
  );
  router.get(
    "/trade-posts/:id/analytics",
    auth(false, true),
    async (req, res) =>
      res.json(
        await c.analytics.summary(
          q(req),
          actor(req),
          pid(req),
          staff(actor(req)),
        ),
      ),
  );
  router.patch("/trade-posts/:id/submit", auth(), async (req, res) =>
    res.json(await c.transition(pid(req), "submit", {}, actor(req))),
  );
  router.patch("/trade-posts/:id", auth(false, true), async (req, res) =>
    res.json(
      await c.update(pid(req), parse(dto.postPatch, req.body), actor(req)),
    ),
  );
  router.delete("/trade-posts/:id", auth(false, true), async (req, res) => {
    await c.remove(pid(req), actor(req));
    res.status(204).end();
  });
  router.post(
    "/trade-posts/:value/interactions",
    auth(true),
    async (req, res) => {
      const post = await c.publicPost(req.params.value);
      const body = parse(
        z.strictObject({
          type: z.enum(["CONTACT_PHONE", "CONTACT_ZALO", "SHARE"]),
        }),
        req.body,
      );
      await c.analytics.record(post, body.type, actor(req), context(req));
      res.json(ok(true));
    },
  );
  router.post("/trade-posts/:value/save", auth(), saveLimit, async (req, res) =>
    res.json(
      await community.save(req.params.value, actor(req), false, context(req)),
    ),
  );
  router.delete(
    "/trade-posts/:value/save",
    auth(),
    saveLimit,
    async (req, res) => {
      await community.save(req.params.value, actor(req), true);
      res.status(204).end();
    },
  );
  router.get("/trade-posts/:id/reviews/summary", async (req, res) =>
    res.json(await community.summary(pid(req))),
  );
  router.get("/trade-posts/:id/comments", auth(true), async (req, res) =>
    res.json(await community.comments(pid(req), q(req), actor(req))),
  );
  router.get(
    "/trade-posts/:id/comments/:commentId",
    auth(true),
    async (req, res) =>
      res.json(
        await community.comment(
          pid(req),
          parse(dto.uuid, req.params.commentId),
        ),
      ),
  );
  router.post(
    "/trade-posts/:id/comments",
    auth(),
    commentLimit,
    async (req, res) =>
      res
        .status(201)
        .json(
          await community.createComment(
            pid(req),
            parse(dto.reply, req.body).content,
            actor(req),
          ),
        ),
  );
  router.put(
    "/trade-posts/:id/comments/:commentId/reply",
    auth(),
    commentLimit,
    async (req, res) =>
      res.json(
        await community.replyComment(
          pid(req),
          parse(dto.uuid, req.params.commentId),
          parse(dto.reply, req.body).content,
          actor(req),
        ),
      ),
  );
  router.get("/trade-posts/:id/reviews", auth(true), async (req, res) =>
    res.json(
      await community.reviewList(q(req), actor(req), "public", pid(req)),
    ),
  );
  router.post(
    "/trade-posts/:id/reviews",
    auth(),
    reviewLimit,
    async (req, res) =>
      res
        .status(201)
        .json(
          await community.createReview(
            pid(req),
            parse(dto.reviewCreate, req.body),
            actor(req),
          ),
        ),
  );
  router.post(
    "/trade-posts/:id/reviews/:reviewId/replies",
    auth(),
    reviewLimit,
    async (req, res) =>
      res
        .status(201)
        .json(
          await community.customerReply(
            parse(dto.uuid, req.params.reviewId),
            parse(dto.reply, req.body).content,
            actor(req),
            pid(req),
          ),
        ),
  );
  router.get("/reviews/me", auth(), async (req, res) =>
    res.json(await community.reviewList(q(req), actor(req), "author")),
  );
  router.patch("/reviews/:id", auth(), async (req, res) =>
    res.json(
      await community.changeReview(
        pid(req),
        parse(dto.reviewPatch, req.body),
        actor(req),
      ),
    ),
  );
  router.delete("/reviews/:id", auth(false, true), async (req, res) => {
    await community.changeReview(pid(req), {}, actor(req), "delete");
    res.status(204).end();
  });
  router.post("/reviews/:id/images", auth(), async (req, res) =>
    res.json(
      await community.reviewImage(
        pid(req),
        parse(z.strictObject({ mediaId: dto.uuid }), req.body).mediaId,
        actor(req),
      ),
    ),
  );
  router.delete("/reviews/:id/images/:imageId", auth(), async (req, res) =>
    res.json(
      await community.reviewImage(
        pid(req),
        parse(dto.uuid, req.params.imageId),
        actor(req),
        true,
      ),
    ),
  );
  router.get("/trade-management/reviews", auth(), async (req, res) =>
    res.json(await community.reviewList(q(req), actor(req), "seller")),
  );
  router.put("/trade-management/reviews/:id/reply", auth(), async (req, res) =>
    res.json(
      await community.ownerReply(
        pid(req),
        parse(dto.reply, req.body).content,
        actor(req),
      ),
    ),
  );
  router.delete(
    "/trade-management/reviews/:id/reply",
    auth(),
    async (req, res) => {
      await community.ownerReply(pid(req), null, actor(req));
      res.status(204).end();
    },
  );
  router.get("/trade-posts/:value", auth(true), async (req, res) => {
    const result = await c.get(req.params.value, actor(req));
    await c.analytics.record(
      { _id: result.data.id },
      "VIEW",
      actor(req),
      context(req),
    );
    res.json(result);
  });
  router.post(
    "/trade-conversations",
    auth(),
    chatOpenLimit,
    async (req, res) => {
      const body = parse(
        z.strictObject({
          tradePostId: dto.uuid,
          message: z.string().trim().min(1).max(1000),
        }),
        req.body,
      );
      res
        .status(201)
        .json(
          await community.openConversation(
            body.tradePostId,
            body.message,
            actor(req),
          ),
        );
    },
  );
  router.get("/trade-conversations", auth(), async (req, res) =>
    res.json(await community.conversations(q(req), actor(req))),
  );
  router.get("/trade-conversations/:id", auth(), async (req, res) =>
    res.json(ok(present(await community.conversation(pid(req), actor(req))))),
  );
  router.get("/trade-conversations/:id/messages", auth(), async (req, res) =>
    res.json(await community.messages(pid(req), q(req), actor(req))),
  );
  router.post(
    "/trade-conversations/:id/messages",
    auth(),
    chatLimit,
    async (req, res) =>
      res
        .status(201)
        .json(
          await community.send(
            pid(req),
            parse(dto.message, req.body).content,
            actor(req),
          ),
        ),
  );
  router.patch("/trade-conversations/:id/read", auth(), async (req, res) =>
    res.json(await community.read(pid(req), actor(req))),
  );
  // Bounded SSE sessions also work on serverless hosts. The database remains the
  // durable source of chat messages; clients reconnect and reload after events.
  router.get("/trade-conversations/:id/events", auth(), async (req, res) => {
    const conversationId = pid(req),
      user = actor(req);
    const conversation = await community.conversation(conversationId, user);
    let cursor = new Date(),
      busy = false,
      closed = false;
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    const timer = setInterval(async () => {
      if (busy || closed) return;
      busy = true;
      try {
        await community.conversation(conversationId, user);
        const rows = await c.messages
          .find({
            conversationId,
            createdAt: { $gte: cursor },
            senderId: { $ne: user.id },
          })
          .sort({ createdAt: 1, _id: 1 })
          .toArray();
        for (const row of rows) {
          res.write(
            "event: CHAT_MESSAGE\ndata: " +
              JSON.stringify({
                conversationId,
                tradePostId: conversation.tradePostId,
                message: present(row),
              }) +
              "\n\n",
          );
          cursor = new Date(row.createdAt.getTime() + 1);
        }
        if (!rows.length) res.write(": keepalive\n\n");
      } catch {
        res.end();
      } finally {
        busy = false;
      }
    }, 3000);
    const end = setTimeout(() => res.end(), 25000);
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(end);
    });
  });
  router.get("/admin/trade-posts", async (req, res) =>
    res.json(await c.list(q(req), req.user, "admin")),
  );
  router.get("/admin/trade-posts/analytics/summary", async (req, res) =>
    res.json(await c.analytics.summary(q(req), req.user, undefined, true)),
  );
  router.get("/admin/trade-posts/:id/analytics", async (req, res) =>
    res.json(await c.analytics.summary(q(req), req.user, pid(req), true)),
  );
  router.get("/admin/trade-posts/:id", async (req, res) =>
    res.json(await c.get(pid(req), req.user, true)),
  );
  router.patch("/admin/trade-posts/:id", async (req, res) =>
    res.json(
      await c.update(pid(req), parse(dto.postPatch, req.body), req.user),
    ),
  );
  for (const action of [
    "approve",
    "reject",
    "hide",
    "unhide",
    "archive",
    "feature",
  ])
    router.patch("/admin/trade-posts/:id/" + action, async (req, res) =>
      res.json(
        await c.transition(
          pid(req),
          action,
          action === "reject"
            ? parse(dto.reason, req.body)
            : action === "feature"
              ? parse(z.strictObject({ featured: z.boolean() }), req.body)
              : parse(z.strictObject({}), req.body || {}),
          req.user,
        ),
      ),
    );
  router.delete("/admin/trade-posts/:id", async (req, res) => {
    await c.remove(pid(req), req.user, true);
    res.status(204).end();
  });
  router.get("/admin/reviews", async (req, res) =>
    res.json(await community.reviewList(q(req), req.user, "admin")),
  );
  router.get("/admin/reviews/stats", async (req, res) =>
    res.json(
      ok(
        await c.reviews
          .aggregate([
            { $match: { deletedAt: null } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ])
          .toArray(),
      ),
    ),
  );
  router.get("/admin/reviews/:id", async (req, res) => {
    const row = await c.reviews.findOne({ _id: pid(req), deletedAt: null });
    if (!row) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy đánh giá.");
    res.json(ok(present(row)));
  });
  router.patch("/admin/reviews/:id/status", async (req, res) =>
    res.json(
      await community.changeReview(
        pid(req),
        parse(
          z.strictObject({ status: z.enum(["PUBLISHED", "HIDDEN"]) }),
          req.body,
        ),
        req.user,
        "status",
      ),
    ),
  );
  router.delete("/admin/reviews/:id", async (req, res) => {
    await community.changeReview(pid(req), {}, req.user, "delete");
    res.status(204).end();
  });
  router.get("/admin/trade-conversations", async (req, res) =>
    res.json(await community.conversations(q(req), req.user, true)),
  );
  router.get("/admin/trade-conversations/:id/messages", async (req, res) =>
    res.json(await community.messages(pid(req), q(req), req.user, true)),
  );
  router.get("/admin/trade-conversations/:id", async (req, res) =>
    res.json(
      ok(present(await community.conversation(pid(req), req.user, true))),
    ),
  );
  router.delete("/admin/trade-conversations/:id", async (req, res) => {
    await community.deleteConversation(pid(req), req.user);
    res.status(204).end();
  });
  router.get("/admin/trade-users", async (req, res) => {
    const query = q(req),
      filter = { ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await Promise.all([
      c.auth.users
        .find(filter, { projection: { sourceId: 0 } })
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      c.auth.users.countDocuments(filter),
    ]);
    res.json(page(rows, total, query));
  });
  router.patch("/admin/trade-users/:id", superAdmin, async (req, res) =>
    res.json(
      ok(
        present(
          await c.auth.adminAccount(
            req.user,
            pid(req),
            parse(
              z.strictObject({
                status: z.enum(["ACTIVE", "BLOCKED"]).optional(),
                businessType: z
                  .enum([
                    "GENERAL",
                    "TEMPLE_MANAGEMENT",
                    "RESTAURANT",
                    "ACCOMMODATION",
                    "GARDEN",
                  ])
                  .optional(),
              }),
              req.body,
            ),
          ),
        ),
      ),
    ),
  );
  const notifications = (adminMode) => async (req, res) => {
    const query = q(req),
      user = adminMode ? req.user : actor(req);
    const filter = {
      $and: [
        adminMode
          ? { staff: true }
          : {
              $or: [
                { userId: user.id },
                { broadcast: true, excludeUserId: { $ne: user.id } },
              ],
            },
        { excludeUserIds: { $nin: [user.id] } },
      ],
    };
    const [rows, total] = await Promise.all([
      c.notifications
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      c.notifications.countDocuments(filter),
    ]);
    res.json(
      page(
        rows.map((row) => ({ ...row, read: row.readBy.includes(user.id) })),
        total,
        query,
      ),
    );
  };
  router.get("/trade-notifications", auth(), notifications(false));
  router.get("/admin/trade-notifications", notifications(true));
  router.patch("/trade-notifications/read", auth(), async (req, res) => {
    const body = parse(
      z.strictObject({ ids: z.array(dto.uuid).max(100) }),
      req.body,
    );
    await c.notifications.updateMany(
      {
        _id: { $in: body.ids },
        $or: [
          { userId: actor(req).id },
          { broadcast: true, excludeUserId: { $ne: actor(req).id } },
        ],
      },
      { $addToSet: { readBy: actor(req).id } },
    );
    res.json(ok(true));
  });
  return router;
}
