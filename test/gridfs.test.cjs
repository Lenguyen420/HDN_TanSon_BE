const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { access } = require("node:fs/promises");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { png } = require("./image-fixture.cjs");

test("Vercel images persist in MongoDB across app restarts and failed content writes are cleaned up", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      VERCEL: "1",
      MONGODB_URI: mongo.getUri("gridfs_isolated_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD: "",
      CORS_ORIGINS: "https://fehdntanson.vercel.app",
    });
    const directory = join(tmpdir(), "gridfs-no-disk-" + randomUUID());
    app = await createApp({ uploadDirectory: directory });
    // Large enough to need several chunks with GridFS's default chunk size.
    const bytes = png(512, 512);
    const dto = {
      id: "persistent-banner",
      image: "data:image/png;base64," + bytes.toString("base64"),
      alt: "Banner",
      order: 1,
      status: "active",
    };
    const service = app.locals.services.content.banners;
    const created = await service.create(dto);
    const image = created.data.image;
    assert.match(image, /^uploads\/banners\/.+\.png$/);
    await assert.rejects(access(directory), { code: "ENOENT" });
    const count = () =>
      app.locals.db.db.collection("images.files").countDocuments();
    assert.equal(await count(), 1);
    const storedImage = await app.locals.db.db
      .collection("images.files")
      .findOne({ filename: image });
    assert.equal(
      await app.locals.db.db.collection("images.chunks").countDocuments({
        files_id: storedImage._id,
      }),
      1,
      "a resized image should be stored in one chunk",
    );
    await assert.rejects(service.create(dto));
    assert.equal(
      await count(),
      1,
      "duplicate content must not leave an orphan image",
    );
    const updated = await service.update(dto.id, { image });
    assert.equal(updated.data.image, image);
    await assert.rejects(
      service.update(dto.id, {
        image: "uploads/banners/" + randomUUID() + ".png",
      }),
      /không còn tồn tại/,
    );
    const storage = service.imageStorage;
    await assert.rejects(
      storage.prepare("data:image/png;base64,AAAA", "banners"),
      /định dạng/,
    );
    await closeApp(app);
    app = undefined;
    app = await createApp({ uploadDirectory: directory });
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port;
    const response = await fetch(base + "/" + image, {
      headers: { Origin: "https://fehdntanson.vercel.app" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://fehdntanson.vercel.app",
    );
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const head = await fetch(base + "/" + image, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(
      (await fetch(base + "/uploads/banners/" + randomUUID() + ".png")).status,
      404,
    );
    assert.equal((await fetch(base + "/uploads/private.txt")).status, 404);
    const list = await (await fetch(base + "/api/v1/public/banners")).json();
    assert.equal(list.data[0].image, image);
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
