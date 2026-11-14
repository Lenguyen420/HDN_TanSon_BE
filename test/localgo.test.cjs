const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
let mongo, runtime, app, server, base, admin, owner, other, guest;
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
async function account(active = true, member = true) {
  const sourceId = String(Math.floor(Math.random() * 1e14));
  const memberId = randomUUID();
  if (member)
    await app.locals.models.members.create({
      _id: memberId,
      zaloUserId: sourceId,
      name: "Hội viên",
      company: "Tân Sơn",
      joinedAt: "2026-01-01",
      status: active ? "active" : "inactive",
    });
  const userId = randomUUID();
  await app.locals.services.tradeAuth.users.insertOne({
    _id: userId,
    source: "zalo",
    sourceId,
    status: "ACTIVE",
  });
  const { createTokenService } = await import("../src/config/jwt.js");
  const token = await createTokenService(process.env.JWT_SECRET).signAsync(
    { sub: userId },
    { expiresIn: 1800, issuer: "tanson-backend", audience: "tanson-trade" },
  );
  return { token, memberId, sourceId, userId };
}
const valid = () => ({
  name: "Quán Tân Sơn",
  category: "an-uong",
  description: "Ẩm thực",
  address: "Phường Tân Sơn",
  location: { type: "Point", coordinates: [106.6, 10.8] },
  coverImage: "https://example.com/cover.png",
});
before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("localgo_test");
  process.env.JWT_SECRET = secret();
  process.env.ADMIN_USERNAME = "localgo_admin";
  process.env.ADMIN_PASSWORD = secret();
  runtime = await import("../src/main.js");
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  admin = (
    await request("/auth/admin-login", "POST", {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    })
  ).body.data.accessToken;
  owner = await account();
  other = await account();
  guest = await account(true, false);
});
after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("LocalGo rejects unauthenticated, inactive, guest and forged ownership writes", async () => {
  assert.equal((await request("/localgo/places", "POST", valid())).status, 401);
  assert.equal(
    (await request("/localgo/places", "POST", valid(), guest.token)).status,
    403,
  );
  const inactive = await account(false);
  assert.equal(
    (await request("/localgo/places", "POST", valid(), inactive.token)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/localgo/places",
        "POST",
        { ...valid(), memberId: other.memberId },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/localgo/places",
        "POST",
        { ...valid(), status: "draft" },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/admin/localgo/places", "GET", undefined, owner.token))
      .status,
    401,
  );
});
test("LocalGo validates coordinates, category, images, HTML, URLs and empty patches", async () => {
  for (const change of [
    { location: { type: "Point", coordinates: [181, 10] } },
    { location: { type: "Point", coordinates: [100, -91] } },
    { location: { type: "Point", coordinates: [100, 10, 1] } },
    { category: "unknown" },
    { coverImage: "javascript:alert(1)" },
    { coverImage: "" },
    { website: "javascript:alert(1)" },
    { content: '<img src=x onerror="alert(1)">' },
  ])
    assert.equal(
      (
        await request(
          "/localgo/places",
          "POST",
          { ...valid(), ...change },
          owner.token,
        )
      ).status,
      400,
    );
  assert.equal(
    (await request("/localgo/places/x", "PATCH", {}, owner.token)).status,
    400,
  );
});
test("LocalGo publishes immediately, filters safely, isolates ownership, hides and soft deletes", async () => {
  const created = await request(
    "/localgo/places",
    "POST",
    valid(),
    owner.token,
  );
  assert.equal(created.status, 201);
  const place = created.body.data,
    path = "/localgo/places/" + place.id;
  assert.equal(place.memberId, owner.memberId);
  assert.equal(place.createdBy, owner.userId);
  assert.equal(place.status, "published");
  assert.equal(place.isVisible, true);
  assert.equal(place.auditLog, undefined);
  assert.equal((await request(path)).status, 200);
  assert.equal(
    (await request("/localgo/places?category=an-uong&search=T%C3%A2n")).body
      .pagination.total,
    1,
  );
  assert.equal(
    (await request("/localgo/places?category=y-te")).body.pagination.total,
    0,
  );
  assert.equal(
    (await request("/localgo/places?search=%2E%2A")).body.pagination.total,
    0,
  );
  for (const [suffix, method, body] of [
    ["", "PATCH", { name: "Chiếm quyền" }],
    ["/visibility", "PATCH", { isVisible: false }],
    ["", "DELETE", undefined],
    ["/manage", "GET", undefined],
  ])
    assert.equal(
      (await request(path + suffix, method, body, other.token)).status,
      403,
    );
  assert.equal(
    (await request("/localgo/my-places", "GET", undefined, other.token)).body
      .pagination.total,
    0,
  );
  assert.equal(
    (await request(path, "PATCH", { description: "Đã sửa" }, owner.token))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        path + "/visibility",
        "PATCH",
        { isVisible: false },
        owner.token,
      )
    ).status,
    200,
  );
  assert.equal((await request(path)).status, 404);
  assert.equal(
    (await request("/localgo/my-places", "GET", undefined, owner.token)).body
      .pagination.total,
    1,
  );
  assert.equal(
    (await request(path + "/manage", "GET", undefined, owner.token)).status,
    200,
  );
  assert.equal(
    (await request(path, "PATCH", { isVisible: true }, admin)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/localgo/places/" + place.id + "/hide",
        "PATCH",
        { reason: "Vi phạm" },
        admin,
      )
    ).status,
    200,
  );
  assert.equal((await request(path)).status, 404);
  assert.equal((await request("/localgo/places")).body.pagination.total, 0);
  assert.equal(
    (await request("/admin/localgo/places", "GET", undefined, admin)).body
      .pagination.total,
    1,
  );
  assert.equal((await request(path, "DELETE", undefined, admin)).status, 204);
  assert.equal(
    (await request(path, "PATCH", { name: "Khôi phục trái phép" }, owner.token))
      .status,
    404,
  );
  assert.equal(
    (await request("/localgo/my-places", "GET", undefined, owner.token)).body
      .pagination.total,
    0,
  );
  const stored = await app.locals.models.localgoPlaces
    .findById(place.id)
    .select("+auditLog")
    .lean();
  assert.ok(stored.deletedAt);
  assert.equal(stored.auditLog.at(-2).reason, "Vi phạm");
  assert.equal(
    stored.auditLog.at(-1).actorId,
    (await app.locals.services.auth.authenticate(admin)).id,
  );
});
test("LocalGo rechecks membership revocation, supports Zalo identity and indexes GeoJSON", async () => {
  await app.locals.models.members.updateOne(
    { _id: owner.memberId },
    { $set: { status: "inactive" } },
  );
  assert.equal(
    (await request("/localgo/places", "POST", valid(), owner.token)).status,
    403,
  );
  await app.locals.models.members.updateOne(
    { _id: owner.memberId },
    { $set: { status: "active" } },
  );
  const access = app.locals.services.memberAccess,
    original = access.transport;
  access.transport = async () => ({
    ok: true,
    json: async () => ({ id: owner.sourceId }),
  });
  try {
    assert.equal(
      (await request("/localgo/places", "POST", valid(), "verified-zalo-token"))
        .status,
      201,
    );
  } finally {
    access.transport = original;
  }
  assert.equal(
    (await request("/localgo/places", "POST", valid(), admin)).status,
    201,
  );
  const nearby = await app.locals.models.localgoPlaces.find({
    location: { $near: { $geometry: valid().location, $maxDistance: 1000 } },
    deletedAt: null,
  });
  assert.equal(nearby.length, 2);
  assert.equal((await request("/localgo/categories")).body.data.length, 11);
});
