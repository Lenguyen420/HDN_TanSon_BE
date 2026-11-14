const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let mongo, runtime, app, server, base, admin, owner, other, guest;
let clientIp = "192.0.2.1";
const secret = () => randomBytes(32).toString("hex");
async function request(path, method = "GET", body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": clientIp,
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
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri("localgo_test");
  process.env.JWT_SECRET = secret();
  process.env.ADMIN_USERNAME = "localgo_admin";
  process.env.ADMIN_PASSWORD = secret();
  runtime = await import("../src/main.js");
  process.env.IMAGE_STORAGE = "mongodb";
  app = await runtime.createApp();
  app.set("trust proxy", 1);
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

test("LocalGo categories persist, authorize writes, validate references and preserve legacy codes", async () => {
  clientIp = "192.0.2.2";
  const path = "/admin/localgo/categories";
  assert.equal(
    (await request(path, "POST", { code: "moi", name: "Mới" })).status,
    401,
  );
  assert.equal(
    (await request(path, "POST", { code: "moi", name: "Mới" }, owner.token))
      .status,
    401,
  );
  for (const body of [
    { code: "../bad", name: "Tên" },
    { code: "new", name: " " },
    { code: "new", name: "<b>Tên</b>" },
    { code: "new", name: "Tên", extra: true },
  ])
    assert.equal((await request(path, "POST", body, admin)).status, 400);
  const category = { code: "the-thao", name: "Thể thao" };
  assert.equal((await request(path, "POST", category, admin)).status, 201);
  assert.equal((await request(path, "POST", category, admin)).status, 409);
  assert.equal(
    (await request(path, "GET", undefined, admin)).body.data.some(
      (row) => row.code === category.code,
    ),
    true,
  );
  assert.equal(
    (
      await request(
        path + "/the-thao",
        "PATCH",
        { name: "Thể thao & sức khỏe" },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        path + "/the-thao",
        "PATCH",
        { code: "doi-ma", name: "Tên" },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request(path + "/missing", "PATCH", { name: "Tên" }, admin)).status,
    404,
  );
  assert.equal(
    (await request(path + "/missing", "DELETE", undefined, admin)).status,
    404,
  );
  const created = await request(
    "/localgo/places",
    "POST",
    { ...valid(), category: category.code },
    admin,
  );
  assert.equal(created.status, 201);
  assert.equal(
    (await request("/localgo/places?category=the-thao")).body.pagination.total,
    1,
  );
  const placePath = "/localgo/places/" + created.body.data.id;
  assert.equal(
    (
      await request(
        placePath + "/visibility",
        "PATCH",
        { isVisible: false },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(path + "/the-thao", "DELETE", undefined, admin)).status,
    409,
  );
  assert.equal(
    (await request(placePath, "DELETE", undefined, admin)).status,
    204,
  );
  assert.equal(
    (await request(path + "/the-thao", "DELETE", undefined, admin)).status,
    204,
  );
  assert.equal(
    (
      await request(
        "/localgo/places",
        "POST",
        { ...valid(), category: "the-thao" },
        admin,
      )
    ).status,
    400,
  );
  assert.equal((await request(path, "POST", category, admin)).status, 409);
  assert.equal(
    (await request(path + "/du-lich", "PATCH", { name: "Du lịch mới" }, admin))
      .status,
    200,
  );
  assert.equal(
    (await request(path + "/khac", "DELETE", undefined, admin)).status,
    204,
  );
  await app.locals.services.localgo.initialize();
  const categories = (await request("/localgo/categories")).body.data;
  assert.equal(
    categories.some((row) => row.code === "khac" || row.code === "the-thao"),
    false,
  );
  assert.equal(
    categories.find((row) => row.code === "du-lich").name,
    "Du lịch mới",
  );
  assert.equal((await request("/localgo/places?category=an-uong")).status, 200);
});

test("concurrent category deletion and assignment cannot create dangling references", async () => {
  const service = app.locals.services.localgo;
  const actor = await app.locals.services.auth.authenticate(admin);
  await service.createCategory({ code: "race-test", name: "Đồng thời" });
  const results = await Promise.allSettled([
    service.create({ ...valid(), category: "race-test" }, actor),
    service.removeCategory("race-test"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const category = await app.locals.models.localgoCategories
    .findById("race-test")
    .lean();
  const places = await app.locals.models.localgoPlaces.countDocuments({
    category: "race-test",
    deletedAt: null,
  });
  assert.equal(Boolean(category.deletedAt) && places > 0, false);
});

test("LocalGo uploads cover/gallery through shared GridFS storage and cleans failed saves", async () => {
  clientIp = "192.0.2.3";
  const bytes = Buffer.alloc(220000);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  const image = "data:image/png;base64," + bytes.toString("base64");
  const created = await request(
    "/localgo/places",
    "POST",
    { ...valid(), coverImage: image, images: [image] },
    admin,
  );
  assert.equal(created.status, 201);
  const row = created.body.data;
  assert.match(row.coverImage, /^uploads\/localgo\/[a-f0-9-]{36}\.png$/);
  assert.match(row.images[0], /^uploads\/localgo\/[a-f0-9-]{36}\.png$/);
  const stored = await app.locals.models.localgoPlaces.findById(row.id).lean();
  assert.equal(stored.coverImage.startsWith("data:"), false);
  const response = await fetch(new URL("/" + row.coverImage, base));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const files = app.locals.db.db.collection("images.files");
  const count = await files.countDocuments();
  assert.equal(
    (
      await request(
        "/localgo/places/" + row.id,
        "PATCH",
        { name: "Đổi tên", coverImage: row.coverImage, images: row.images },
        admin,
      )
    ).status,
    200,
  );
  assert.equal(await files.countDocuments(), count);
  const invalid =
    "data:image/png;base64," + Buffer.from("not a PNG").toString("base64");
  assert.equal(
    (
      await request(
        "/localgo/places",
        "POST",
        { ...valid(), coverImage: image, images: [image, invalid] },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(await files.countDocuments(), count);
  assert.equal(
    (
      await request(
        "/localgo/places",
        "POST",
        { ...valid(), category: "does-not-exist", coverImage: image },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(await files.countDocuments(), count);
  assert.equal(
    (await request("/localgo/places/" + row.id, "DELETE", undefined, admin))
      .status,
    204,
  );
  assert.equal(await files.countDocuments(), count);
});

test("map resolver requires admin and returns an explicit pin without Google network access", async () => {
  clientIp = "192.0.2.4";
  const path = "/admin/localgo/resolve-map";
  const body = {
    url: "https://www.google.com/maps/place/Test/@11,107,15z/data=!3d10.815!4d106.63",
  };
  assert.equal((await request(path, "POST", body)).status, 401);
  assert.equal((await request(path, "POST", body, owner.token)).status, 401);
  const resolved = await request(path, "POST", body, admin);
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.data, { latitude: 10.815, longitude: 106.63 });
  assert.equal(
    (await request(path, "POST", { url: "https://127.0.0.1/" }, admin)).status,
    400,
  );
  assert.equal(
    (await request(path, "POST", { url: body.url, extra: true }, admin)).status,
    400,
  );
});
