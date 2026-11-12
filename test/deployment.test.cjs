const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

test("trusted proxy rate limits use client IP and ignore untrusted Forwarded values", async (t) => {
  const { createRateLimiter } = await import("../src/middlewares/rateLimit.js");
  const diagnostics = t.mock.method(console, "error", () => {});
  const app = express();
  app.set("trust proxy", 1);
  app.use(createRateLimiter(1));
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (ip, forwarded) =>
    fetch(base, { headers: { "X-Forwarded-For": ip, Forwarded: forwarded } });
  const first = await request("198.51.100.1", "for=203.0.113.1");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ip: "198.51.100.1" });
  assert.equal((await request("198.51.100.1", "for=203.0.113.2")).status, 429);
  assert.equal((await request("198.51.100.2", "for=203.0.113.1")).status, 200);
  assert.equal(diagnostics.mock.calls.length, 0);
});

test("Zalo Vietnam IP restriction is a server availability error and never writes an unverified profile", async () => {
  const { MemberAccessService } =
    await import("../src/services/memberAccessService.js");
  let databaseReads = 0;
  const members = {
    findOne: () => {
      databaseReads++;
      throw Error("Unexpected database read");
    },
  };
  const service = new MemberAccessService(
    members,
    { get: () => "" },
    null,
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        error: -501,
        message:
          "Personal information is limited due to IP address not inside Vietnam",
      }),
    }),
  );
  await assert.rejects(
    service.session("real-provider-token"),
    (error) => error.status === 503 && /ngoài Việt Nam/.test(error.message),
  );
  assert.equal(databaseReads, 0);
  service.transport = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: -124 }),
  });
  await assert.rejects(
    service.session("invalid-token"),
    (error) => error.status === 401,
  );
  assert.equal(databaseReads, 0);
});
