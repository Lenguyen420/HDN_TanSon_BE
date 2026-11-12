const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { png } = require("./image-fixture.cjs");
let mongo,
  runtime,
  app,
  server,
  base,
  admin,
  seller,
  customer,
  other,
  category,
  post;
const secret = () => randomBytes(32).toString("hex");
async function request(path, method = "GET", body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}
async function account(name, business = false) {
  const registrationId = randomUUID(),
    token = secret(),
    memberId = business ? randomUUID() : null;
  if (memberId)
    await app.locals.models.members.create({
      _id: memberId,
      name,
      company: "Doanh nghiệp " + name,
      joinedAt: "2026-01-01",
      status: "active",
    });
  await app.locals.models.registrations.create({
    _id: registrationId,
    fullName: name,
    company: "Doanh nghiệp " + name,
    phone: "0900000001",
    date: "2026-01-01",
    status: business ? "approved" : "pending",
    memberId: memberId || undefined,
    notificationTokenHash: createHash("sha256").update(token).digest("hex"),
  });
  const session = await request("/trade-session", "POST", { tokens: [token] });
  assert.equal(session.status, 200);
  return { ...session.body.data, receipt: token, registrationId, memberId };
}
const valid = () => ({
  category: category.code,
  title: "Kết nối dịch vụ doanh nghiệp",
  summary: "Giải pháp dành cho hội viên",
  description: "Nội dung kết nối giao thương",
  purpose: "COMMERCIAL",
  priceType: "CONTACT",
  address: "Phường Tân Sơn",
  contactName: "Hội viên",
  contactPhone: "0900000001",
  imageIds: [],
});
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri("trade_isolated_test");
  process.env.JWT_SECRET = secret();
  process.env.ADMIN_USERNAME = "trade_admin";
  const password = secret();
  process.env.ADMIN_PASSWORD = password;
  runtime = await import("../src/main.js");
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  admin = (
    await request("/auth/admin-login", "POST", {
      username: "trade_admin",
      password,
    })
  ).body.data.accessToken;
  seller = await account("Doanh nghiệp A", true);
  customer = await account("Khách B");
  other = await account("Khách C");
});
after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("trade authenticates secret receipts, rejects forged identities and revokes inactive sellers", async () => {
  assert.equal(
    (await request("/trade-session", "POST", { tokens: [secret()] })).status,
    401,
  );
  assert.equal(
    (await request("/trade-session", "POST", { zaloUserId: "123" })).status,
    400,
  );
  assert.equal(
    (await request("/trade-posts", "POST", {}, customer.accessToken)).status,
    400,
  );
  const actor = (
    await request("/trade-session", "GET", undefined, seller.accessToken)
  ).body.data;
  assert.equal(actor.role, "BUSINESS");
  await app.locals.models.members.updateOne(
    { _id: seller.memberId },
    { $set: { status: "inactive" } },
  );
  assert.equal(
    (await request("/trade-session", "GET", undefined, seller.accessToken)).body
      .data.status,
    "PENDING",
  );
  await app.locals.models.members.updateOne(
    { _id: seller.memberId },
    { $set: { status: "active" } },
  );
});
test("categories enforce versions, reorder rollback and duplicate stable codes", async () => {
  const created = await request(
    "/admin/trade-post-categories",
    "POST",
    { code: "dich-vu", name: "Dịch vụ doanh nghiệp" },
    admin,
  );
  assert.equal(created.status, 201);
  category = created.body.data;
  assert.equal(
    (
      await request(
        "/admin/trade-post-categories",
        "POST",
        { code: category.code, name: "Trùng" },
        admin,
      )
    ).body.code,
    "TRADE_POST_CATEGORY_CODE_EXISTS",
  );
  const update = await request(
    "/admin/trade-post-categories/" + category.id,
    "PATCH",
    { version: 1, description: "Kết nối hội viên" },
    admin,
  );
  assert.equal(update.status, 200);
  category = update.body.data;
  assert.equal(
    (
      await request(
        "/admin/trade-post-categories/" + category.id,
        "PATCH",
        { version: 1, name: "Cũ" },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/admin/trade-post-categories/reorder",
        "PATCH",
        {
          items: [
            { id: category.id, version: 2 },
            { id: randomUUID(), version: 1 },
          ],
        },
        admin,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/admin/trade-post-categories/" + category.id,
        "GET",
        undefined,
        admin,
      )
    ).body.data.version,
    2,
  );
});
test("post lifecycle validates merged edits and preserves first-publication notifications", async () => {
  assert.equal(
    (await request("/trade-posts", "POST", valid(), customer.accessToken))
      .status,
    403,
  );
  const created = await request(
    "/trade-posts",
    "POST",
    valid(),
    seller.accessToken,
  );
  assert.equal(created.status, 201);
  post = created.body.data;
  assert.equal(post.status, "DRAFT");
  assert.equal((await request("/trade-posts/" + post.id)).status, 404);
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id,
        "PATCH",
        { featured: true },
        seller.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/submit",
        "PATCH",
        {},
        seller.accessToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id,
        "PATCH",
        { summary: "Đang chờ" },
        seller.accessToken,
      )
    ).body.code,
    "TRADE_POST_NOT_EDITABLE",
  );
  assert.equal(
    (
      await request(
        "/admin/trade-posts/" + post.id + "/approve",
        "PATCH",
        {},
        admin,
      )
    ).status,
    200,
  );
  assert.equal((await request("/trade-posts/" + post.id)).status, 200);
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id,
        "PATCH",
        { priceType: "FIXED" },
        seller.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id,
        "PATCH",
        { summary: "Tóm tắt cập nhật" },
        seller.accessToken,
      )
    ).body.data.status,
    "PUBLISHED",
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id,
        "PATCH",
        { title: "Cơ hội hợp tác mới" },
        seller.accessToken,
      )
    ).body.data.status,
    "PENDING",
  );
  assert.equal(
    (
      await request(
        "/admin/trade-posts/" + post.id + "/approve",
        "PATCH",
        {},
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    await app.locals.services.trade.notifications.countDocuments({
      type: "TRADE_POST_NEW",
      tradePostId: post.id,
    }),
    1,
  );
});
test("public expiry precedence and inactive categories apply consistently without changing status", async () => {
  const c = app.locals.services.trade;
  await c.posts.updateOne(
    { _id: post.id },
    {
      $set: {
        eventEndAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 86400000),
      },
    },
  );
  assert.equal((await request("/trade-posts/" + post.id)).status, 200);
  await c.posts.updateOne({ _id: post.id }, { $set: { expiresAt: null } });
  assert.equal((await request("/trade-posts/" + post.id)).status, 404);
  assert.equal((await c.posts.findOne({ _id: post.id })).status, "PUBLISHED");
  await c.posts.updateOne({ _id: post.id }, { $set: { eventEndAt: null } });
  await c.categories.updateOne(
    { _id: category.id },
    { $set: { isActive: false } },
  );
  assert.equal((await request("/trade-posts/" + post.id)).status, 404);
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/save",
        "POST",
        {},
        customer.accessToken,
      )
    ).status,
    404,
  );
  await c.categories.updateOne(
    { _id: category.id },
    { $set: { isActive: true } },
  );
  assert.equal(
    (
      await request(
        "/admin/trade-post-categories/" + category.id,
        "DELETE",
        undefined,
        admin,
      )
    ).body.code,
    "TRADE_POST_CATEGORY_IN_USE",
  );
});
test("concurrent saves are idempotent and analytics never store raw IP", async () => {
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(
        "/trade-posts/" + post.id + "/save",
        "POST",
        {},
        customer.accessToken,
      ),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(
    (await app.locals.services.trade.posts.findOne({ _id: post.id })).saveCount,
    1,
  );
  assert.equal(
    await app.locals.services.trade.events.countDocuments({
      tradePostId: post.id,
      type: "SAVE",
    }),
    1,
  );
  const event = await app.locals.services.trade.events.findOne({
    type: "VIEW",
  });
  assert.equal(event.ip, undefined);
  assert.match(event.visitorHash, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await request(
        "/trade-posts/me/saved",
        "GET",
        undefined,
        customer.accessToken,
      )
    ).body.data.length,
    1,
  );
});
test("reviews serialize aggregates, enforce unique active review and preserve hidden state", async () => {
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/reviews",
        "POST",
        { rating: 5, content: "Tự đánh giá" },
        seller.accessToken,
      )
    ).status,
    403,
  );
  const results = await Promise.all([
    request(
      "/trade-posts/" + post.id + "/reviews",
      "POST",
      { rating: 5, content: "Kết nối hiệu quả" },
      customer.accessToken,
    ),
    request(
      "/trade-posts/" + post.id + "/reviews",
      "POST",
      { rating: 3, content: "Thông tin hữu ích" },
      other.accessToken,
    ),
  ]);
  assert.ok(
    results.every((r) => r.status === 201),
    JSON.stringify(results),
  );
  const review = results[0].body.data;
  assert.equal(
    (await app.locals.services.trade.posts.findOne({ _id: post.id }))
      .averageRating,
    4,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/reviews",
        "POST",
        { rating: 4, content: "Trùng" },
        customer.accessToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/reviews/" + review.id + "/replies",
        "POST",
        { content: "Cảm ơn" },
        customer.accessToken,
      )
    ).body.code,
    "TRADE_REVIEW_OWNER_REPLY_REQUIRED",
  );
  assert.equal(
    (
      await request(
        "/trade-management/reviews/" + review.id + "/reply",
        "PUT",
        { content: "Cảm ơn hội viên" },
        seller.accessToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/reviews/" + review.id + "/replies",
        "POST",
        { content: "Mong tiếp tục hợp tác" },
        customer.accessToken,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/admin/reviews/" + review.id + "/status",
        "PATCH",
        { status: "HIDDEN" },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/reviews/" + review.id,
        "PATCH",
        { rating: 1, content: "Cập nhật" },
        customer.accessToken,
      )
    ).body.data.status,
    "HIDDEN",
  );
  assert.equal(
    (await app.locals.services.trade.posts.findOne({ _id: post.id }))
      .averageRating,
    3,
  );
  assert.equal(
    (
      await request(
        "/reviews/" + review.id,
        "DELETE",
        undefined,
        customer.accessToken,
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/reviews",
        "POST",
        { rating: 4, content: "Đánh giá lại" },
        customer.accessToken,
      )
    ).status,
    201,
  );
});
test("private conversations reuse identities, hide outsider IDs and stay closed after moderation", async () => {
  const opened = await request(
    "/trade-conversations",
    "POST",
    { tradePostId: post.id, message: "Tôi muốn kết nối hợp tác" },
    customer.accessToken,
  );
  assert.equal(opened.status, 201);
  const conversation = opened.body.data;
  const again = await request(
    "/trade-conversations",
    "POST",
    { tradePostId: post.id, message: "Thông tin bổ sung" },
    customer.accessToken,
  );
  assert.equal(again.body.data.id, conversation.id);
  assert.equal(
    (
      await request(
        "/trade-conversations/" + conversation.id + "/messages",
        "GET",
        undefined,
        other.accessToken,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/trade-conversations/" + conversation.id + "/messages",
        "POST",
        { content: "Chào hội viên" },
        seller.accessToken,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/trade-conversations/" + conversation.id + "/read",
        "PATCH",
        {},
        customer.accessToken,
      )
    ).status,
    200,
  );
  const messages = await request(
    "/trade-conversations/" + conversation.id + "/messages",
    "GET",
    undefined,
    customer.accessToken,
  );
  assert.equal(messages.body.data.length, 3);
  assert.equal(
    (
      await request(
        "/admin/trade-conversations/" + conversation.id,
        "DELETE",
        undefined,
        admin,
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(
        "/trade-conversations",
        "POST",
        { tradePostId: post.id, message: "Mở lại" },
        customer.accessToken,
      )
    ).status,
    410,
  );
});
test("media ownership, nonprofit fields and analytics are enforced", async () => {
  const c = app.locals.services.trade;
  const uploaded = await c.mediaService.upload(png(), seller.user);
  const mediaId = uploaded.data.id;
  assert.equal(
    (
      await request(
        "/trade-posts",
        "POST",
        { ...valid(), imageIds: [mediaId] },
        customer.accessToken,
      )
    ).status,
    403,
  );
  const nonprofit = await request(
    "/trade-posts",
    "POST",
    {
      ...valid(),
      purpose: "NON_PROFIT",
      price: 10000,
      priceType: "FIXED",
      imageIds: [mediaId],
    },
    seller.accessToken,
  );
  assert.equal(nonprofit.status, 201);
  assert.equal(nonprofit.body.data.price, null);
  assert.equal(nonprofit.body.data.thumbnailUrl, uploaded.data.url);
  assert.equal(
    (
      await request(
        "/trade-posts/" + post.id + "/analytics",
        "GET",
        undefined,
        other.accessToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/admin/trade-posts/analytics/summary",
        "GET",
        undefined,
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/trade-posts/" + nonprofit.body.data.id,
        "DELETE",
        undefined,
        seller.accessToken,
      )
    ).status,
    204,
  );
  assert.equal(await c.media.findOne({ _id: mediaId }), null);
});
test("purpose, promotion, image ownership and Google Maps rules reject invalid merged content", async () => {
  const c = app.locals.services.trade,
    manager = await app.locals.services.auth.authenticate(admin);
  const promotion = (
    await c.createCategory(
      {
        code: "uu-dai-hoi-vien",
        name: "Ưu đãi hội viên",
        requiresPromotionDetails: true,
      },
      manager,
    )
  ).data;
  const from = new Date(Date.now() + 86400000).toISOString(),
    to = new Date(Date.now() + 2 * 86400000).toISOString();
  await assert.rejects(
    c.create({ ...valid(), category: promotion.code }, seller.user),
    (e) => e.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    c.create({ ...valid(), promotionPercent: 10 }, seller.user),
    (e) => e.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    c.create(
      {
        ...valid(),
        category: promotion.code,
        promotionPercent: 10,
        promotionStartAt: to,
        promotionEndAt: from,
      },
      seller.user,
    ),
    (e) => e.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    c.create(
      { ...valid(), category: promotion.code, purpose: "NON_PROFIT" },
      seller.user,
    ),
    (e) => e.code === "VALIDATION_ERROR",
  );
  const row = (
    await c.create(
      {
        ...valid(),
        category: promotion.code,
        promotionPercent: 10,
        promotionStartAt: from,
        promotionEndAt: to,
      },
      seller.user,
    )
  ).data;
  assert.equal(row.promotionPercent, 10);
  await assert.rejects(
    c.update(row.id, { promotionStartAt: to }, seller.user),
    (e) => e.code === "VALIDATION_ERROR",
  );
  const uploaded = await c.mediaService.upload(png(), customer.user);
  await assert.rejects(
    c.create({ ...valid(), imageIds: [uploaded.data.id] }, seller.user),
    (e) => e.status === 400 && e.code === "RESOURCE_NOT_FOUND",
  );
  assert.deepEqual(
    (await c.media.findOne({ _id: uploaded.data.id })).references,
    [],
  );
  await c.mediaService.discard(uploaded.data.id, customer.user);
  await c.auth.users.updateOne(
    { _id: seller.user.id },
    { $set: { businessType: "TEMPLE_MANAGEMENT" } },
  );
  try {
    const fresh = await c.auth.authenticate(seller.accessToken);
    await assert.rejects(
      c.create(valid(), fresh),
      (e) => e.code === "TRADE_POST_PURPOSE_NOT_ALLOWED",
    );
    const { purpose, ...withoutPurpose } = valid();
    const community = (await c.create(withoutPurpose, fresh)).data;
    assert.equal(community.purpose, "NON_PROFIT");
    assert.equal(community.priceType, null);
  } finally {
    await c.auth.users.updateOne(
      { _id: seller.user.id },
      { $set: { businessType: "GENERAL" } },
    );
  }
  const { postCreate } = await import("../src/dto/trade.dto.js");
  assert.equal(
    postCreate.safeParse({
      ...valid(),
      googleMapsUrl: "https://google.attacker.example/maps/place",
    }).success,
    false,
  );
  assert.equal(
    postCreate.safeParse({
      ...valid(),
      googleMapsUrl: "https://www.google.com/maps/place/Tan-Son",
    }).success,
    true,
  );
  assert.equal(
    postCreate.safeParse({ ...valid(), price: 1.00001 }).success,
    false,
  );
});
test("notification failure does not undo committed moderation, and blocked users cannot reuse a JWT", async () => {
  const c = app.locals.services.trade,
    manager = await app.locals.services.auth.authenticate(admin),
    send = c.notifications.insertOne;
  c.notifications.insertOne = async () => {
    throw Error("notification unavailable");
  };
  try {
    const result = await c.transition(
      post.id,
      "feature",
      { featured: true },
      manager,
    );
    assert.equal(result.data.featured, true);
    assert.equal((await c.posts.findOne({ _id: post.id })).featured, true);
  } finally {
    c.notifications.insertOne = send;
  }
  await c.auth.users.updateOne(
    { _id: customer.user.id },
    { $set: { status: "BLOCKED" } },
  );
  await assert.rejects(
    c.auth.authenticate(customer.accessToken),
    (e) => e.status === 401 && e.code === "ACCOUNT_BLOCKED",
  );
  await c.auth.users.updateOne(
    { _id: customer.user.id },
    { $set: { status: "ACTIVE" } },
  );
});
