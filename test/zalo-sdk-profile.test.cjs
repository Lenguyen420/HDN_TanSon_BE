const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
let mongo, runtime, app, server, base;
const sample = {
  zaloUserId: "123456789",
  name: "Tên từ SDK",
  avatar: "https://example.com/avatar.jpg",
};
const save = (body) =>
  fetch(base + "/public/zalo-profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("zalo_sdk_profile_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "";
  process.env.ADMIN_PASSWORD = "";
  runtime = await import("../src/main.js");
});
test.beforeEach(async () => {
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  app.locals.services.memberAccess.transport = () => {
    throw Error("Must not verify SDK profile with Zalo");
  };
});
test.afterEach(async () => {
  if (app) await runtime.closeApp(app, server);
});
test.after(async () => {
  if (mongo) await mongo.stop();
});

test("SDK name/avatar persist in MongoDB without token verification, never in verified users or members", async () => {
  const response = await save(sample);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.verificationStatus, "unverified");
  assert.equal(data.linked, false);
  assert.equal(data.member, null);
  assert.deepEqual(data.user, {
    id: sample.zaloUserId,
    name: sample.name,
    avatar: sample.avatar,
    phone: null,
  });
  const record = await app.locals.db
    .collection("zalo_sdk_profiles")
    .findOne({ _id: sample.zaloUserId });
  assert.equal(record.name, sample.name);
  assert.equal(record.source, "mini-app-sdk");
  assert.equal(record.verificationStatus, "unverified");
  assert.ok(record.consentReportedAt instanceof Date);
  assert.equal(await app.locals.models.zaloUsers.countDocuments(), 0);
  assert.equal(await app.locals.models.members.countDocuments(), 0);
  assert.equal((await fetch(base + "/member/identity")).status, 401);
  assert.equal((await fetch(base + "/auth/me")).status, 401);
  assert.equal((await fetch(base + "/public/zalo-profiles")).status, 404);
});

test("repeat consent updates the unverified profile without overwriting a verified user", async () => {
  await app.locals.models.zaloUsers.create({
    _id: sample.zaloUserId,
    name: "Verified name",
  });
  const response = await save({ ...sample, name: "Tên SDK mới", avatar: "" });
  assert.equal(response.status, 200);
  assert.equal(await app.locals.models.zaloSdkProfiles.countDocuments(), 1);
  assert.equal(
    (await app.locals.models.zaloSdkProfiles.findById(sample.zaloUserId).lean())
      .name,
    "Tên SDK mới",
  );
  assert.equal(
    (await app.locals.models.zaloUsers.findById(sample.zaloUserId).lean()).name,
    "Verified name",
  );
});

test("client cannot submit verified status, privileges, phone claims or unsafe image URLs", async () => {
  for (const payload of [
    { ...sample, verificationStatus: "verified" },
    { ...sample, linked: true },
    { ...sample, phone: "0900000001" },
    { ...sample, avatar: "javascript:alert(1)" },
    { ...sample, zaloUserId: { $ne: null } },
    { ...sample, name: " " },
  ])
    assert.equal((await save(payload)).status, 400);
});
