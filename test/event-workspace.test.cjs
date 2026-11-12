const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
test("event resources and self check-in persist without exposing other attendees", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    const password = randomBytes(24).toString("base64url");
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("event_workspace_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "event_admin",
      ADMIN_PASSWORD: password,
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const request = async (path, method = "GET", body, headers = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const login = await request("/auth/admin-login", "POST", {
      username: "event_admin",
      password,
    });
    const auth = { Authorization: "Bearer " + login.body.accessToken };
    // The token is returned under data in the auth controller.
    if (!login.body.accessToken)
      auth.Authorization = "Bearer " + login.body.data.accessToken;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const event = {
      id: "event-workspace",
      title: "Sự kiện Hội",
      topic: "Kết nối",
      publishedAt: "2020-01-01",
      status: "published",
      summary: "Chương trình",
      paragraphs: ["Nội dung"],
      image: "",
      event: {
        date: today,
        time: "08:00",
        venue: "Hội trường",
        address: "Tân Sơn",
        host: "Ban tổ chức",
        checkInEnabled: true,
        agenda: [],
        documents: [
          {
            id: "doc-1",
            title: "Tài liệu chương trình",
            url: "https://example.com/doc.pdf",
          },
        ],
        minutes: [
          {
            id: "minutes-1",
            title: "Biên bản",
            url: "https://example.com/minutes.pdf",
            publishedAt: today,
          },
        ],
      },
    };
    const created = await request("/admin/events", "POST", event, auth);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const publicEvent = await request("/public/events/event-workspace");
    assert.equal(publicEvent.body.data.event.documents[0].id, "doc-1");
    const legacyUpdate = structuredClone(event);
    delete legacyUpdate.event.documents;
    delete legacyUpdate.event.minutes;
    delete legacyUpdate.event.checkInEnabled;
    delete legacyUpdate.event.host;
    const updated = await request(
      "/admin/events/event-workspace",
      "PUT",
      legacyUpdate,
      auth,
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.event.documents.length, 1);
    assert.equal(updated.body.data.event.minutes.length, 1);
    assert.equal(updated.body.data.event.checkInEnabled, true);
    const invalid = structuredClone(event);
    invalid.id = "invalid-file";
    invalid.event.documents[0].url = "javascript:alert(1)";
    assert.equal(
      (await request("/admin/events", "POST", invalid, auth)).status,
      400,
    );
    const receiptToken = randomBytes(32).toString("hex");
    const payload = {
      token: receiptToken,
      name: "Nguyễn Văn A",
      company: "Công ty A",
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("/public/events/event-workspace/check-in", "POST", payload),
      ),
    );
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.body.data.name, payload.name);
      assert.equal(result.body.data.tokenHash, undefined);
    }
    assert.equal(await app.locals.models.eventAttendance.countDocuments(), 1);
    const own = await request(
      "/public/events/event-workspace/check-in",
      "GET",
      undefined,
      { "X-Attendance-Token": receiptToken },
    );
    assert.equal(own.body.data.name, payload.name);
    assert.equal(
      (
        await request(
          "/public/events/event-workspace/check-in",
          "GET",
          undefined,
          { "X-Attendance-Token": randomBytes(32).toString("hex") },
        )
      ).body.data,
      null,
    );
    assert.equal(
      (await request("/public/events/event-workspace/check-in")).status,
      400,
    );
    assert.equal(
      (await request("/admin/events/event-workspace/attendance")).status,
      401,
    );
    const attendees = await request(
      "/admin/events/event-workspace/attendance",
      "GET",
      undefined,
      auth,
    );
    assert.equal(attendees.status, 200);
    assert.equal(attendees.body.pagination.total, 1);
    event.event.checkInEnabled = false;
    await request("/admin/events/event-workspace", "PUT", event, auth);
    assert.equal(
      (
        await request("/public/events/event-workspace/check-in", "POST", {
          ...payload,
          token: randomBytes(32).toString("hex"),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/public/events/event-workspace/check-in",
          "POST",
          payload,
        )
      ).status,
      200,
      "retry is idempotent after closing",
    );
    event.event.checkInEnabled = true;
    event.event.date = "2099-01-01";
    await request("/admin/events/event-workspace", "PUT", event, auth);
    assert.equal(
      (
        await request("/public/events/event-workspace/check-in", "POST", {
          ...payload,
          token: randomBytes(32).toString("hex"),
        })
      ).status,
      409,
    );
    event.status = "draft";
    await request("/admin/events/event-workspace", "PUT", event, auth);
    assert.equal(
      (
        await request(
          "/public/events/event-workspace/check-in",
          "POST",
          payload,
        )
      ).status,
      404,
    );
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
