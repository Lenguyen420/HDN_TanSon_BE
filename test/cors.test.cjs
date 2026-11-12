const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cors = require("cors");

test("deployed Zalo origin and configured web origins pass CORS, including preflight", async () => {
  const { corsOptions } = await import("../src/config/cors.js");
  const app = express();
  app.use(
    cors(
      corsOptions({
        get: () => "https://fehdntanson.vercel.app,http://localhost:3003",
      }),
    ),
  );
  app.get("/api", (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const url = "http://127.0.0.1:" + server.address().port + "/api";
    for (const origin of [
      "https://h5.zdn.vn",
      "https://fehdntanson.vercel.app",
      "http://localhost:3003",
    ]) {
      const response = await fetch(url, { headers: { Origin: origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.deepEqual(await response.json(), { ok: true });
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-origin"),
        origin,
      );
      assert.match(
        preflight.headers.get("access-control-allow-headers"),
        /content-type/,
      );
      assert.match(
        preflight.headers.get("access-control-allow-methods"),
        /POST/,
      );
    }
    const blocked = await fetch(url, {
      headers: { Origin: "https://h5.zdn.vn.evil.example" },
    });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    await blocked.body.cancel();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
