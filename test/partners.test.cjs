const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
test("partners: admin authorization, public totals, soft deletion, idempotency, notification links and validation", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const runtime = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    Object.assign(process.env, {
      MONGODB_URI: mongo.getUri("partners_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "partner_admin",
      ADMIN_PASSWORD: randomBytes(24).toString("hex"),
    });
    app = await runtime.createApp();
    server = await runtime.listen(app, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    let token = "";
    const req = async (path, method = "GET", body, auth = token) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: "Bearer " + auth } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const login = await req("/auth/admin-login", "POST", {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200);
    token = login.body.data.accessToken;
    const company = {
      name: "Công ty Đồng hành",
      description: "Giới thiệu không bị mất",
      industry: "Dịch vụ",
      isPublished: true,
      requestId: randomUUID(),
    };
    assert.equal(
      (await req("/admin/partners", "POST", company, "")).status,
      401,
    );
    assert.equal(
      (await req("/admin/partners", "POST", company, "fake-member-token"))
        .status,
      401,
    );
    const pair = await Promise.all([
      req("/admin/partners", "POST", company),
      req("/admin/partners", "POST", company),
    ]);
    assert.ok(pair.every((r) => r.status === 201));
    const id = pair[0].body.data.id;
    assert.equal(pair[1].body.data.id, id);
    assert.equal(
      (await req("/admin/partners", "POST", { ...company, name: "Changed" }))
        .status,
      409,
    );
    const draft = (
      await req("/admin/partners", "POST", {
        name: "PRIVATE_DRAFT",
        requestId: randomUUID(),
      })
    ).body.data;
    const contribution = (extra = {}) => ({
      title: "Tài trợ Tết",
      type: "money",
      paymentMethod: "bank_transfer",
      amount: 50000000,
      contributionDate: "2026-11-10",
      description: "Đóng góp cho cộng đồng",
      isPublished: true,
      requestId: randomUUID(),
      ...extra,
    });
    const money = contribution({ sendNotification: true });
    const repeated = await Promise.all([
      req(`/admin/partners/${id}/contributions`, "POST", money),
      req(`/admin/partners/${id}/contributions`, "POST", money),
    ]);
    assert.ok(
      repeated.every((r) => r.status === 201),
      JSON.stringify(repeated),
    );
    assert.equal(repeated[0].body.data.id, repeated[1].body.data.id);
    const cashId = repeated[0].body.data.id;
    const item = await req(
      `/admin/partners/${id}/contributions`,
      "POST",
      contribution({
        type: "in_kind",
        amount: null,
        paymentMethod: null,
        itemName: "Quà",
        quantity: 100,
        estimatedValue: 9000000,
      }),
    );
    assert.equal(item.status, 201);
    const second = await req(
      `/admin/partners/${id}/contributions`,
      "POST",
      contribution({ amount: 10000000 }),
    );
    assert.equal(second.status, 201);
    await req(
      `/admin/partners/${id}/contributions`,
      "POST",
      contribution({
        isPublished: false,
        title: "PRIVATE_CONTRIBUTION",
        amount: 80000000,
      }),
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${draft.id}/contributions`,
          "POST",
          contribution({ sendNotification: true }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ amount: -1 }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ amount: null }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ type: "in_kind", itemName: "", quantity: 0 }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ contributionDate: "2026-02-30" }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ images: ["data:image/png;base64,YWJj"] }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution({ images: ["x".repeat(1400001)] }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `/admin/partners/${id}/contributions`,
          "POST",
          contribution(),
          "",
        )
      ).status,
      401,
    );
    assert.equal(
      (await req(`/admin/contributions/${cashId}`, "PATCH", { amount: 1 }, ""))
        .status,
      401,
    );
    assert.equal(
      (await req(`/admin/contributions/${cashId}`, "DELETE", undefined, ""))
        .status,
      401,
    );
    const list = await req("/public/partners");
    assert.equal(list.status, 200);
    assert.equal(list.body.summary.totalAmount, 60000000);
    assert.equal(list.body.summary.contributionCount, 3);
    assert.equal(list.body.summary.inKindCount, 1);
    assert.equal(list.body.summary.totalPartners, 1);
    assert.equal(list.body.data[0].totalAmount, 60000000);
    assert.equal(list.body.data[0].latestContributions.length, 3);
    assert.ok(
      list.body.data[0].latestContributions.some(
        (c) => c.itemName === "Quà" && c.quantity === 100,
      ),
    );
    assert.ok(
      list.body.data[0].latestContributions.every(
        (c) => !c.notification && !c.audit && !c.requestHash,
      ),
    );
    assert.ok(!JSON.stringify(list.body).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(list.body).includes("createdBy"));
    assert.ok(!JSON.stringify(list.body).includes("memberId"));
    const detail = await req(`/partners/${id}`);
    assert.equal(detail.body.data.contributions.length, 3);
    assert.ok(
      detail.body.data.contributions.every(
        (c) => !c.audit && !c.notification && !c.requestHash,
      ),
    );
    assert.equal((await req(`/partners/${draft.id}`)).status, 404);
    let feed = await req("/public/notification-feed?source=partners");
    assert.equal(feed.status, 200);
    assert.equal(feed.body.data.length, 2);
    const contributionNotice = feed.body.data.find(
      (n) => n.contributionId === cashId,
    );
    assert.equal(contributionNotice.partnerId, id);
    assert.equal(contributionNotice.contributionId, cashId);
    const noticeId = contributionNotice.id;
    const edited = await req(`/admin/contributions/${cashId}`, "PATCH", {
      amount: 30000000,
      title: "Đã sửa",
      sendNotification: true,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.description, money.description);
    assert.equal(edited.body.data.paymentMethod, "bank_transfer");
    assert.ok(edited.body.data.audit.length >= 2);
    assert.equal(edited.body.data.notification.status, "sent");
    feed = await req("/public/notification-feed?source=partners");
    assert.equal(feed.body.data.length, 2);
    assert.equal(
      feed.body.data.find((n) => n.contributionId === cashId).id,
      noticeId,
    );
    assert.equal(
      (await req("/public/partners")).body.summary.totalAmount,
      40000000,
    );
    assert.equal(
      (
        await req(`/admin/contributions/${cashId}`, "PATCH", {
          isPublished: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (await req("/public/partners")).body.summary.totalAmount,
      10000000,
    );
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.data.length,
      1,
    );
    await req(`/admin/contributions/${cashId}`, "PATCH", { isPublished: true });
    assert.equal(
      (await req("/public/partners")).body.summary.totalAmount,
      40000000,
    );
    await req(`/admin/contributions/${second.body.data.id}`, "DELETE");
    assert.equal(
      (await req("/public/partners")).body.summary.totalAmount,
      30000000,
    );
    const ranged = await req(
      "/admin/partners/statistics?from=2026-11-11&to=2026-11-30",
    );
    assert.equal(ranged.body.data.totalAmount, 0);
    assert.equal(
      (await req("/admin/partners/statistics?from=2026-11-30&to=2026-11-01"))
        .status,
      400,
    );
    const stats = await req("/admin/partners/statistics");
    assert.equal(stats.body.data.byPartner[0].totalAmount, 30000000);
    assert.equal(stats.body.data.estimatedValue, 9000000);
    const hidden = await req(`/admin/partners/${id}`, "PATCH", {
      isPublished: false,
    });
    assert.equal(hidden.body.data.description, company.description);
    assert.equal(hidden.body.data.industry, company.industry);
    assert.equal((await req(`/public/partners/${id}`)).status, 404);
    assert.equal((await req("/public/partners")).body.summary.totalAmount, 0);
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      0,
    );
    await req(`/admin/partners/${id}`, "PATCH", { isPublished: true });
    const target = await req(
      `/public/partners/${id}?page=2&limit=1&contributionId=${cashId}`,
    );
    assert.equal(target.body.data.selectedContribution.id, cashId);
    assert.equal(target.body.data.selectedContribution.notification, undefined);
    const privateId = (
      await req(`/admin/partners/${id}`)
    ).body.data.contributions.find((c) => !c.isPublished).id;
    assert.equal(
      (await req(`/public/partners/${id}?contributionId=${privateId}`)).body
        .data.selectedContribution,
      null,
    );
    assert.equal((await req(`/admin/partners/${id}`, "DELETE")).status, 200);
    assert.equal((await req(`/public/partners/${id}`)).status, 404);
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      0,
    );
    assert.equal(
      (await req(`/admin/partners/${id}/contributions`, "POST", contribution()))
        .status,
      404,
    );
    // Draft units stay silent; their first publication broadcasts once to everyone.
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      0,
    );
    const publishedDraft = await req(`/admin/partners/${draft.id}`, "PATCH", {
      isPublished: true,
    });
    assert.equal(publishedDraft.status, 200);
    assert.equal(publishedDraft.body.data.notification.status, "sent");
    const sentAt = publishedDraft.body.data.notification.sentAt;
    const publishedNotices = (
      await req("/public/notification-feed?source=partners")
    ).body.data;
    assert.equal(publishedNotices.length, 1);
    assert.equal(publishedNotices[0].partnerId, draft.id);
    assert.equal(publishedNotices[0].contributionId, undefined);
    await req(`/admin/partners/${draft.id}`, "PATCH", {
      name: "Đã đổi tên",
      sendNotification: true,
    });
    await req(`/admin/partners/${draft.id}`, "PATCH", { isPublished: false });
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      0,
    );
    const republished = await req(`/admin/partners/${draft.id}`, "PATCH", {
      isPublished: true,
    });
    assert.equal(republished.body.data.notification.sentAt, sentAt);
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      1,
    );
    await req(`/admin/partners/${draft.id}`, "DELETE");
    // Legacy published units can be explicitly announced once without recreating them.
    await app.locals.models.partners.partners.create({
      _id: "legacy-partner",
      name: "Đơn vị cũ",
      isPublished: true,
    });
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      0,
    );
    assert.equal(
      (
        await req("/admin/partners/legacy-partner", "PATCH", {
          sendNotification: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await req("/public/notification-feed?source=partners")).body.pagination
        .total,
      1,
    );
  } finally {
    if (app) await runtime.closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
