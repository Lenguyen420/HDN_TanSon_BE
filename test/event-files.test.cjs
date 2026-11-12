const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

test("admin uploads optional event files to MongoDB; Mini App downloads original bytes", async () => {
  const mongo = await MongoMemoryServer.create();
  const directory = await mkdtemp(path.join(tmpdir(), "event-file-test-"));
  let app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    const password = randomBytes(20).toString("hex");
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("event_files_test"),
      JWT_SECRET: randomBytes(40).toString("hex"),
      ADMIN_USERNAME: "file-admin",
      ADMIN_PASSWORD: password,
    });
    app = await createApp({ uploadDirectory: directory });
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const login = await fetch(base + "/auth/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "file-admin", password }),
    });
    const { data: session } = await login.json();
    const bytes = Buffer.from("%PDF-1.4\n" + "document".repeat(40000));
    const upload = (name, body, token = session.accessToken) =>
      fetch(base + "/admin/event-files", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(name),
        },
        body,
      });
    assert.equal((await upload("file.pdf", bytes, "wrong-token")).status, 401);
    assert.equal((await upload("file.html", bytes)).status, 400);
    assert.equal(
      (await upload("fake.pdf", Buffer.from("not a pdf"))).status,
      400,
    );
    const response = await upload("Tài liệu.pdf", bytes);
    assert.equal(response.status, 201);
    const uploaded = (await response.json()).data;
    assert.match(
      uploaded.url,
      /^\/api\/v1\/public\/event-files\/[a-f0-9-]{36}$/,
    );
    const file = await fetch(
      "http://127.0.0.1:" + server.address().port + uploaded.url,
    );
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.ok(
      file.headers.get("content-disposition").includes("filename*=UTF-8"),
    );
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    const head = await fetch(
      "http://127.0.0.1:" + server.address().port + uploaded.url,
      { method: "HEAD" },
    );
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const record = await app.locals.db
      .collection("event_files.files")
      .findOne();
    assert.equal(record.metadata.uploadedBy, session.user.id);
    const dto = {
      id: "event-optional-files",
      title: "Event",
      topic: "Topic",
      publishedAt: "2020-01-01",
      status: "published",
      summary: "Summary",
      paragraphs: ["Body"],
      event: {
        date: "2026-12-01",
        time: "08:00 - 10:00",
        venue: "Venue",
        address: "Address",
      },
    };
    const save = (method, endpoint, body) =>
      fetch(base + endpoint, {
        method,
        headers: {
          Authorization: "Bearer " + session.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await save("POST", "/admin/events", dto)).status, 201);
    dto.event.documents = [
      { id: "doc-1", title: "Tài liệu", url: uploaded.url },
    ];
    dto.event.minutes = [];
    assert.equal(
      (await save("PUT", "/admin/events/" + dto.id, dto)).status,
      200,
    );
    assert.equal(
      (await (await fetch(base + "/public/events/" + dto.id)).json()).data.event
        .documents[0].url,
      uploaded.url,
    );
    assert.equal(
      (await upload("large.pdf", Buffer.alloc(4 * 1024 * 1024 + 1))).status,
      413,
    );
    assert.equal(
      await app.locals.db.collection("event_files.files").countDocuments(),
      1,
    );
    await closeApp(app, server);
    app = null;
    server = null;
    app = await createApp({ uploadDirectory: directory });
    server = await listen(app, 0, "127.0.0.1");
    const afterRestart = await fetch(
      "http://127.0.0.1:" + server.address().port + uploaded.url,
    );
    assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), bytes);
  } finally {
    if (app) await closeApp(app, server);
    await mongo.stop();
    assert.ok(
      path
        .resolve(directory)
        .startsWith(path.resolve(tmpdir()) + path.sep + "event-file-test-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
