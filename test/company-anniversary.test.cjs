const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");

test("company anniversaries are public, use Vietnam dates and deduplicate businesses without personal birthdays", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("anniversary_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD: "",
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    const service = app.locals.services.publicNotifications;
    service.clock = () => new Date("2026-11-12T17:01:00Z");
    const rows = [
      {
        _id: "a1",
        company: "Doanh nghiệp A",
        companyFoundedAt: "2016-11-13",
        phone: "PRIVATE_PHONE",
        email: "private@example.com",
      },
      {
        _id: "a2",
        company: " doanh nghiệp a ",
        companyFoundedAt: "2016-11-13",
      },
      { _id: "b", company: "Công ty B", companyFoundedAt: "2010-11-13" },
      {
        _id: "inactive",
        company: "Ngừng hoạt động",
        companyFoundedAt: "2010-11-13",
        status: "inactive",
      },
      {
        _id: "deleted",
        company: "Đã xóa",
        companyFoundedAt: "2010-11-13",
        deletedAt: new Date(),
      },
      { _id: "missing", company: "Thiếu ngày" },
      {
        _id: "personal",
        company: "Sinh nhật cá nhân",
        birthDate: "1990-11-13",
        companyFoundedAt: "2010-11-14",
      },
      {
        _id: "future",
        company: "Ngày tương lai",
        companyFoundedAt: "2027-11-13",
      },
      { _id: "zero", company: "Vừa thành lập", companyFoundedAt: "2026-11-13" },
      { _id: "empty-company", company: " ", companyFoundedAt: "2010-11-13" },
      { _id: "leap", company: "Công ty nhuận", companyFoundedAt: "2020-02-29" },
      {
        _id: "invalid-leap",
        company: "Ngày sai",
        companyFoundedAt: "2001-02-29",
      },
    ];
    await app.locals.models.members.collection.insertMany(
      rows.map((row) => ({
        name: "PRIVATE_MEMBER_NAME",
        joinedAt: "2020-01-01",
        status: "active",
        deletedAt: null,
        ...row,
      })),
    );
    const base =
      "http://127.0.0.1:" +
      server.address().port +
      "/api/v1/public/notification-feed";
    const get = async (query) => {
      const response = await fetch(
        base + (query || "?source=company-anniversary"),
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await get();
    assert.equal(first.pagination.total, 2);
    const companyA = first.data.find((n) => n.company === "Doanh nghiệp A");
    assert.ok(companyA);
    assert.equal(companyA.date, "2026-11-13");
    assert.equal(companyA.anniversaryYears, 10);
    assert.equal(companyA.scope, "public");
    assert.equal(companyA.category, "Sinh nhật doanh nghiệp");
    assert.match(companyA.id, /^company-anniversary-[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(first).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(first).includes("private@example.com"));
    assert.deepEqual(
      (await get()).data.map((n) => n.id),
      first.data.map((n) => n.id),
    );
    const paged = await get("?source=company-anniversary&page=2&limit=1");
    assert.equal(paged.data.length, 1);
    assert.equal(paged.pagination.total, 2);
    const combined = await get("?limit=100");
    assert.equal(combined.pagination.total, 2);
    await app.locals.models.members.updateOne(
      { _id: "a1" },
      { $set: { status: "inactive" } },
    );
    assert.ok(
      (await get()).data.some((n) => n.id === companyA.id),
      "other members of the same company keep a stable notice ID",
    );
    service.clock = () => new Date("2027-11-13T01:00:00Z");
    const nextYear = await get();
    assert.ok(!nextYear.data.some((n) => n.id === companyA.id));
    service.clock = () => new Date("2026-11-13T17:01:00Z");
    assert.equal(
      (await get()).pagination.total,
      1,
      "Vietnam is already November 14",
    );
    service.clock = () => new Date("2025-02-28T01:00:00Z");
    const leap = await get();
    assert.equal(leap.pagination.total, 1);
    assert.equal(leap.data[0].company, "Công ty nhuận");
    assert.equal(leap.data[0].anniversaryYears, 5);
    service.clock = () => new Date("2024-02-28T01:00:00Z");
    assert.equal((await get()).pagination.total, 0);
    service.clock = () => new Date("2024-02-29T01:00:00Z");
    assert.equal((await get()).pagination.total, 1);
    service.clock = () => new Date("2025-03-01T01:00:00Z");
    assert.equal((await get()).pagination.total, 0);
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
