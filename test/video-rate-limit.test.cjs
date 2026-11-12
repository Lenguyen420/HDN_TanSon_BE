const test = require("node:test");
const assert = require("node:assert/strict");

test("small video parts have a dedicated limit while other APIs retain 120 requests/minute", async () => {
  const { default: express } = await import("express");
  const { createApiRateLimiter } =
    await import("../src/middlewares/rateLimit.js");
  const { default: videoRouter } =
    await import("../src/routers/introductionVideoRouter.js");
  const { default: errors } =
    await import("../src/middlewares/errorMiddleware.js");
  const { UnauthorizedError } = await import("../src/utils/httpError.js");
  const app = express();
  app.use(
    "/api/v1",
    createApiRateLimiter(),
    videoRouter({
      auth: {
        authenticate: async (token) => {
          if (token !== "test") throw new UnauthorizedError("Unauthorized");
          return { id: "admin", role: "STAFF" };
        },
      },
      introductionVideos: { putPart: async () => ({ success: true }) },
    }),
  );
  app.get("/api/v1/health", (req, res) => res.json({ ok: true }));
  app.use(errors);
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  try {
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const url =
      base +
      "/admin/introduction-videos/00000000-0000-4000-8000-000000000000/chunks/0";
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: Buffer.alloc(12),
        })
      ).status,
      401,
    );
    for (let index = 0; index < 121; index++) {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.alloc(12),
      });
      assert.equal(response.status, 200, "chunk request " + index);
      await response.arrayBuffer();
    }
    for (let index = 0; index < 120; index++) {
      const response = await fetch(base + "/health");
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(base + "/health")).status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
