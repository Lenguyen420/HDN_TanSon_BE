const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");

test("published news/events enter the public inbox without OA while private notices remain protected", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("public_notifications"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD: "",
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const content = app.locals.services.content;
    const article = {
      title: "Nội dung mới",
      topic: "Hoạt động",
      publishedAt: "2000-01-01",
      status: "draft",
      image: "",
      summary: "Tóm tắt bài viết",
      paragraphs: ["Nội dung đầy đủ"],
    };
    await content.news.create({ ...article, id: "news" });
    const get = async (path = "") => {
      const res = await fetch(base + "/public/notification-feed" + path);
      return {
        status: res.status,
        body: await res.json(),
        headers: res.headers,
      };
    };
    assert.equal((await get()).body.pagination.total, 0);
    await content.news.update("news", { status: "published" });
    await content.events.create({
      ...article,
      id: "event",
      status: "published",
      publishedAt: "2000-01-03",
      event: {
        date: "2999-01-01",
        time: "08:00",
        venue: "Hội trường",
        address: "Tân Sơn",
        agenda: [],
      },
    });
    await content.news.create({
      ...article,
      id: "future",
      status: "published",
      publishedAt: "2999-01-01",
    });
    await content.news.create({ ...article, id: "draft" });
    await content.news.create({
      ...article,
      id: "deleted",
      status: "published",
    });
    await content.news.remove("deleted");
    await content.notifications.create({
      id: "manual",
      title: "Thông báo chung",
      category: "Chung",
      date: "2000-01-02",
      time: "",
      status: "published",
      description: "Từ Hội",
      paragraphs: ["Thông báo công khai"],
    });
    await content.notifications.create({
      id: "scheduled",
      title: "Chưa đến giờ",
      category: "Chung",
      date: "2999-01-01",
      time: "23:59",
      status: "published",
      description: "Ẩn",
      paragraphs: ["Ẩn"],
    });
    await app.locals.db.db
      .collection("trade_notifications")
      .insertOne({ title: "PRIVATE_TRADE_SECRET", userId: "someone" });
    await app.locals.db.db
      .collection("registrations")
      .insertOne({
        _id: "secret-registration",
        phone: "PRIVATE_PHONE_SECRET",
        notificationTokenHash: "hash",
      });
    const feed = await get();
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get("cache-control"), "no-store");
    assert.equal(feed.body.pagination.total, 3);
    assert.deepEqual(
      feed.body.data.map((n) => n.id),
      ["content-events-event", "manual", "content-news-news"],
    );
    assert.ok(feed.body.data.every((n) => n.scope === "public"));
    assert.deepEqual(feed.body.data[0].related, {
      category: "events",
      articleId: "event",
    });
    assert.equal(feed.body.data[2].title, "Tin tức mới: Nội dung mới");
    assert.equal(feed.body.data[2].description, article.summary);
    assert.ok(!JSON.stringify(feed.body).includes("PRIVATE_"));
    const page = await get("?page=2&limit=1");
    assert.equal(page.body.data[0].id, "manual");
    assert.equal(page.body.pagination.total, 3);
    assert.equal((await get("?source=news")).body.pagination.total, 1);
    assert.equal((await get("?source=private")).status, 400);
    assert.equal((await get("?search=không-tồn-tại")).body.pagination.total, 0);
    await content.news.update("news", { title: "Đã chỉnh sửa" });
    assert.equal(
      (await get("?source=news")).body.data[0].id,
      "content-news-news",
    );
    assert.equal(
      await app.locals.models.content.notifications.countDocuments(),
      2,
      "derived notices do not duplicate manual records",
    );
    await content.news.update("news", { status: "draft" });
    assert.equal((await get("?source=news")).body.pagination.total, 0);
    assert.equal((await fetch(base + "/trade-notifications")).status, 401);
    assert.equal((await fetch(base + "/admin/registration-inbox")).status, 401);
    const receipts = await fetch(base + "/public/registration-notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: [] }),
    });
    assert.deepEqual((await receipts.json()).data, []);
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
