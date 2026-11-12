const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
test("joining, 30-minute reminders and absence notices use server time and private receipts", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    const password = randomBytes(24).toString("base64url");
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("event_participation_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "participant_admin",
      ADMIN_PASSWORD: password,
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    const service = app.locals.services.eventAttendance;
    let now = new Date("2030-06-01T08:00:00+07:00");
    service.clock = () => new Date(now);
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const req = async (path, method = "GET", body, auth) => {
      const r = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer " + auth } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    await app.locals.models.content.events.create({
      _id: "event-join",
      title: "Sự kiện kết nối",
      topic: "Giao lưu",
      status: "published",
      publishedAt: "2020-01-01",
      summary: "Kết nối",
      paragraphs: ["Nội dung"],
      event: {
        date: "2030-06-01",
        time: "09:00 - 10:00",
        venue: "Hội trường",
        address: "Tân Sơn",
        checkInEnabled: true,
      },
    });
    const tokenA = randomBytes(32).toString("hex"),
      tokenB = randomBytes(32).toString("hex"),
      tokenC = randomBytes(32).toString("hex");
    const join = (token, name) =>
      req("/public/events/event-join/join", "POST", {
        token,
        name,
        company: "Công ty",
      });
    const updates = (tokens) =>
      req("/public/event-updates", "POST", {
        tokens: tokens.map((token) => ({ eventId: "event-join", token })),
      });
    const joined = await Promise.all([
      join(tokenA, "Hội viên A"),
      join(tokenA, "Hội viên A"),
    ]);
    for (const result of joined) {
      assert.equal(result.status, 200);
      assert.equal(result.body.data.status, "registered");
      assert.equal(result.body.data.checkedAt, null);
    }
    assert.equal(await service.records.countDocuments(), 1);
    now = new Date("2030-06-01T08:29:59+07:00");
    assert.equal((await updates([tokenA])).body.data.length, 0);
    now = new Date("2030-06-01T08:30:00+07:00");
    const reminder = (await updates([tokenA])).body;
    assert.equal(reminder.data.length, 1);
    assert.equal(reminder.data[0].createdAt, "2030-06-01T01:30:00.000Z");
    assert.equal(reminder.data[0].related.articleId, "event-join");
    assert.equal(
      (await updates([tokenA])).body.data[0].id,
      reminder.data[0].id,
    );
    assert.equal(
      (await updates([randomBytes(32).toString("hex")])).body.participations
        .length,
      0,
    );
    now = new Date("2030-06-01T08:59:00+07:00");
    assert.equal((await join(tokenB, "Hội viên B")).status, 200);
    const late = (await updates([tokenB])).body;
    assert.equal(late.data.length, 1);
    assert.equal(late.data[0].createdAt, "2030-06-01T01:59:00.000Z");
    now = new Date("2030-06-01T09:15:00+07:00");
    const check = await req("/public/events/event-join/check-in", "POST", {
      token: tokenA,
      name: "Hội viên A",
      company: "Công ty",
    });
    assert.equal(check.status, 200);
    assert.equal(
      (await updates([tokenA])).body.participations[0].status,
      "attended",
    );
    assert.equal((await join(tokenC, "Muộn")).status, 409);
    // Walk-in attendance without prior registration must never create an absence.
    assert.equal(
      (
        await req("/public/events/event-join/check-in", "POST", {
          token: tokenC,
          name: "Khách",
          company: "",
        })
      ).status,
      200,
    );
    now = new Date("2030-06-01T09:59:59+07:00");
    assert.equal(
      (await service.adminInbox({ page: 1, limit: 100 })).absentCount,
      0,
    );
    now = new Date("2030-06-01T10:00:00+07:00");
    const inbox = await service.adminInbox({ page: 1, limit: 100 });
    assert.equal(inbox.absentCount, 1);
    assert.equal(inbox.data[0].participantName, "Hội viên B");
    assert.equal(inbox.data[0].createdAt, "2030-06-01T03:00:00.000Z");
    assert.equal(
      (await service.adminInbox({ page: 1, limit: 100 })).data[0].id,
      inbox.data[0].id,
    );
    assert.equal(
      (await updates([tokenB])).body.participations[0].status,
      "absent",
    );
    assert.equal(
      (
        await req("/public/events/event-join/check-in", "POST", {
          token: tokenB,
          name: "Hội viên B",
          company: "Công ty",
        })
      ).status,
      409,
    );
    assert.equal((await req("/admin/event-inbox")).status, 401);
    const login = await req("/auth/admin-login", "POST", {
      username: "participant_admin",
      password,
    });
    const admin = login.body.data.accessToken;
    assert.equal(
      (
        await req(
          "/admin/event-inbox?page=1&limit=100",
          "GET",
          undefined,
          admin,
        )
      ).body.absentCount,
      1,
    );
    assert.equal(
      (
        await req("/public/event-updates", "POST", {
          tokens: [{ eventId: "event-join", token: "invalid" }],
        })
      ).status,
      400,
    );
    // A moved event uses its current schedule, never the registration's old time.
    await app.locals.models.content.events.updateOne(
      { _id: "event-join" },
      { $set: { "event.time": "11:00 – 12:00" } },
    );
    assert.equal(
      (await service.adminInbox({ page: 1, limit: 100 })).absentCount,
      0,
    );
    assert.equal((await updates([tokenB])).body.data.length, 0);
    now = new Date("2030-06-01T10:30:00+07:00");
    const moved = (await updates([tokenB])).body.data;
    assert.equal(moved.length, 1);
    assert.notEqual(moved[0].id, late.data[0].id);
    await app.locals.models.content.events.updateOne(
      { _id: "event-join" },
      { $set: { status: "draft" } },
    );
    assert.equal((await updates([tokenB])).body.data.length, 0);
    assert.equal(
      (await service.adminInbox({ page: 1, limit: 100 })).absentCount,
      0,
    );
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
