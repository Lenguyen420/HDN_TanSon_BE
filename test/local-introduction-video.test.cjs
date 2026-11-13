const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { mkdtemp, readdir, readFile, rm } = require("node:fs/promises");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { MongoMemoryServer } = require("mongodb-memory-server");

test("save introduction video to disk, publish settings, stream ranges and preserve files after restart", async () => {
  const saved = { ...process.env };
  let mongo, app, server, runtime, directory;
  try {
    mongo = await MongoMemoryServer.create();
    directory = await mkdtemp(join(tmpdir(), "tanson-local-video-"));
    process.env.MONGODB_URI = mongo.getUri("local_video_test");
    process.env.JWT_SECRET = randomBytes(48).toString("hex");
    process.env.ADMIN_USERNAME = "local_video_admin";
    process.env.ADMIN_PASSWORD = randomBytes(24).toString("hex");
    // Check local video serving works even when images are stored in GridFS.
    process.env.IMAGE_STORAGE = "mongodb";
    delete process.env.VERCEL;
    runtime = await import("../src/main.js");
    let base;
    const start = async () => {
      app = await runtime.createApp({ uploadDirectory: directory });
      server = await runtime.listen(app, 0, "127.0.0.1");
      base = `http://127.0.0.1:${server.address().port}`;
    };
    await start();
    const login = await fetch(base + "/api/v1/auth/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    const token = (await login.json()).data.accessToken;
    const bytes = Buffer.alloc(1024, 7);
    bytes.write("ftyp", 4, "ascii");
    const upload = (
      content = bytes,
      name = "intro.mp4",
      type = "video/mp4",
      auth = token,
      field = "video",
    ) => {
      const body = new FormData();
      if (content !== null)
        body.append(field, new Blob([content], { type }), name);
      return fetch(base + "/api/v1/admin/introduction-videos/upload", {
        method: "POST",
        headers: auth ? { Authorization: `Bearer ${auth}` } : {},
        body,
      });
    };
    assert.equal(
      (await upload(bytes, "intro.mp4", "video/mp4", null)).status,
      401,
    );
    assert.equal((await upload(null)).status, 400);
    assert.equal((await upload(bytes, "intro.exe")).status, 400);
    assert.equal((await upload(bytes, "intro.mp4", "video/webm")).status, 400);
    assert.equal((await upload(Buffer.alloc(24))).status, 400);
    assert.equal(
      (await upload(bytes, "intro.mp4", "video/mp4", token, "wrong")).status,
      400,
    );
    assert.deepEqual(await readdir(join(directory, "introduction-videos")), []);
    // Stream more than 100 MiB without holding the whole video in RAM.
    const boundary = "tanson-video-boundary";
    async function* oversizedBody() {
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
      );
      const chunk = Buffer.alloc(1024 * 1024);
      chunk.write("ftyp", 4);
      for (let index = 0; index < 100; index++) yield chunk;
      yield Buffer.from(`x\r\n--${boundary}--\r\n`);
    }
    const oversized = await fetch(
      base + "/api/v1/admin/introduction-videos/upload",
      {
        method: "POST",
        duplex: "half",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: oversizedBody(),
      },
    );
    assert.equal(oversized.status, 413);
    assert.deepEqual(await readdir(join(directory, "introduction-videos")), []);
    const response = await upload();
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    const url = result.data.url;
    assert.match(url, /^\/uploads\/introduction-videos\/[a-f0-9-]{36}\.mp4$/);
    assert.deepEqual(
      await readFile(join(directory, ...url.split("/").slice(2))),
      bytes,
    );
    const settings = await (
      await fetch(base + "/api/v1/public/settings")
    ).json();
    assert.equal(settings.data.introductionVideoUrl, url);
    const row = await app.locals.models.settings.findById("association").lean();
    assert.equal(row.introductionVideoUrl, url);
    assert.equal(
      await app.locals.db.db
        .collection("introduction_video_parts")
        .countDocuments(),
      0,
    );
    const put = async (videoUrl) =>
      fetch(base + "/api/v1/admin/settings", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...settings.data,
          introductionVideoUrl: videoUrl,
        }),
      });
    assert.equal((await put(url)).status, 200);
    assert.equal(
      (
        await put(
          "/uploads/introduction-videos/00000000-0000-4000-8000-000000000000.mp4",
        )
      ).status,
      400,
    );
    assert.equal(
      (await put("/uploads/introduction-videos/../../.env")).status,
      400,
    );
    const service = app.locals.services.settings;
    const update = service.update;
    service.update = async () => {
      throw new Error("database failure");
    };
    assert.equal((await upload()).status, 500);
    service.update = update;
    assert.equal(
      (await readdir(join(directory, "introduction-videos"))).length,
      1,
    );
    process.env.VERCEL = "1";
    assert.equal((await upload()).status, 503);
    delete process.env.VERCEL;
    await runtime.closeApp(app, server);
    app = server = null;
    await start();
    const full = await fetch(base + url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const range = await fetch(base + url, {
      headers: { Range: "bytes=10-30" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 10-30/1024");
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      bytes.subarray(10, 31),
    );
    const head = await fetch(base + url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1024");
    assert.equal(
      head.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    assert.equal(
      (await fetch(base + "/uploads/introduction-videos/.pending.tmp")).status,
      404,
    );
    assert.equal(
      (await (await fetch(base + "/api/v1/public/settings")).json()).data
        .introductionVideoUrl,
      url,
    );
    const webm = Buffer.alloc(16);
    Buffer.from("1a45dfa3", "hex").copy(webm);
    assert.equal((await upload(webm, "intro.webm", "video/webm")).status, 201);
  } finally {
    if (app) await runtime.closeApp(app, server);
    if (mongo) await mongo.stop();
    if (directory) {
      assert.ok(
        resolve(directory).startsWith(
          resolve(tmpdir()) + sep + "tanson-local-video-",
        ),
      );
      await rm(directory, { recursive: true, force: true });
    }
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
