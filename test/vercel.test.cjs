const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { access } = require("node:fs/promises");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

test("startup diagnostics identify configuration errors without logging secrets", async () => {
  const { startupDiagnostic } =
    await import("../src/utils/startupDiagnostic.js");
  assert.match(
    startupDiagnostic(new Error("Điền MONGODB_URI trong .env trước khi chạy.")),
    /^MONGODB_URI_INVALID:/,
  );
  assert.match(
    startupDiagnostic(new Error("JWT_SECRET cần ít nhất 32 ký tự.")),
    /^JWT_SECRET_INVALID:/,
  );
  const unknown = startupDiagnostic(
    new Error("mongodb+srv://user:private-password@example.com/db"),
  );
  assert.match(unknown, /^INITIALIZATION_FAILED:/);
  assert.doesNotMatch(unknown, /private-password|example.com/);
});

test("Vercel entry initializes on request, retries failures and shares one connection", async () => {
  const saved = { ...process.env };
  let mongo, server;
  try {
    process.env.VERCEL = "1";
    process.env.MONGODB_URI = "invalid";
    process.env.JWT_SECRET = randomBytes(48).toString("hex");
    process.env.ADMIN_USERNAME = "";
    process.env.ADMIN_PASSWORD = "";
    const before = mongoose.connections.length;
    const { default: app } = await import("../src/index.js");
    assert.equal(mongoose.connections.length, before);
    const { listen } = await import("../src/main.js");
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port;
    const failure = await fetch(base + "/api/v1/health");
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), {
      statusCode: 500,
      message: "Có lỗi máy chủ. Vui lòng thử lại.",
    });

    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri("tanson_vercel_isolated_test");
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => fetch(base + "/api/v1/health")),
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.equal(mongoose.connections.length, before + 1);
    assert.equal((await fetch(base + "/api/v1/missing")).status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});

test("Vercel skips filesystem setup and rejects local image uploads", async () => {
  const saved = process.env.VERCEL;
  try {
    process.env.VERCEL = "1";
    const { ImageStorage } = await import("../src/services/imageStorage.js");
    const directory = join(tmpdir(), "tanson-vercel-" + randomUUID());
    const storage = new ImageStorage(directory);
    await storage.initialize();
    await assert.rejects(access(directory), { code: "ENOENT" });
    await assert.rejects(
      storage.prepare("data:image/png;base64,AAAA", "news"),
      (error) => error.status === 400 && /Vercel/.test(error.message),
    );
    assert.deepEqual(
      await storage.prepare("https://example.com/image.webp", "news"),
      { image: "https://example.com/image.webp" },
    );
  } finally {
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});
