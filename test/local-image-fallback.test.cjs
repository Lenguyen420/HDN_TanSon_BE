const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { png } = require("./image-fixture.cjs");

test("local backend serves existing MongoDB banners and keeps new image uploads on disk", async () => {
  const saved = { ...process.env };
  let mongo, directory, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    directory = await mkdtemp(join(tmpdir(), "tanson-image-fallback-"));
    delete process.env.VERCEL;
    Object.assign(process.env, {
      IMAGE_STORAGE: "local",
      MONGODB_URI: mongo.getUri("image_read_fallback"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD: "",
    });
    app = await createApp({ uploadDirectory: directory });
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port;
    const service = app.locals.services.content.banners;
    const legacyImage = "uploads/banners/" + randomUUID() + ".png";
    const bytes = png(16, 16);
    const storage = service.imageStorage;
    assert.equal(storage.bucket, null, "new uploads must stay local");
    await pipeline(
      Readable.from([bytes]),
      storage.readBucket.openUploadStream(legacyImage),
    );
    const dto = {
      id: "old-banner",
      image: legacyImage,
      alt: "Banner cũ",
      order: 1,
      status: "active",
    };
    await service.create(dto);
    await service.update(dto.id, { image: legacyImage, alt: "Đã sửa" });
    const response = await fetch(base + "/" + legacyImage);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const head = await fetch(base + "/" + legacyImage, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const created = await service.create({
      ...dto,
      id: "new-banner",
      image: "data:image/png;base64," + bytes.toString("base64"),
    });
    const localImage = created.data.image;
    assert.deepEqual(
      await readFile(join(directory, ...localImage.split("/").slice(1))),
      bytes,
    );
    assert.equal(
      await app.locals.db.db.collection("images.files").countDocuments(),
      1,
    );
    assert.equal((await fetch(base + "/" + localImage)).status, 200);
    const banners = (
      await (await fetch(base + "/api/v1/public/banners")).json()
    ).data;
    assert.equal(banners.length, 2);
    assert.equal(
      (await fetch(base + "/uploads/banners/" + randomUUID() + ".png")).status,
      404,
    );
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    if (directory) {
      assert.ok(
        resolve(directory).startsWith(
          resolve(tmpdir()) + sep + "tanson-image-fallback-",
        ),
      );
      await rm(directory, { recursive: true, force: true });
    }
    process.env = saved;
  }
});
