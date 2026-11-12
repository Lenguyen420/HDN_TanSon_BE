const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let mongo, runtime, app, server, base, admin;
const secret = () => randomBytes(32).toString("hex");
const password = secret();
async function request(path, method = "GET", body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const submit = (notificationToken, name) =>
  request("/public/registrations", "POST", {
    fullName: name,
    company: "Công ty kiểm thử",
    phone: "0900000001",
    notificationToken,
  });
const notices = (tokens) =>
  request("/public/registration-notifications", "POST", { tokens });
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri(
    "registration_notifications_isolated_test",
  );
  process.env.JWT_SECRET = secret();
  process.env.ADMIN_USERNAME = "notification_admin";
  process.env.ADMIN_PASSWORD = password;
  runtime = await import("../src/main.js");
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  admin = (
    await request("/auth/admin-login", "POST", {
      username: "notification_admin",
      password,
    })
  ).body.data.accessToken;
});
test.after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("submission notifies admins; approval/rejection reach only the corresponding receipt", async () => {
  const a = secret(),
    b = secret();
  const first = await submit(a, "Người A"),
    second = await submit(b, "Người B");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await request("/admin/registration-inbox")).status, 401);
  const inbox = await request(
    "/admin/registration-inbox?limit=100",
    "GET",
    undefined,
    admin,
  );
  assert.equal(inbox.body.pendingCount, 2);
  assert.equal(inbox.body.data.length, 2);
  assert.match(inbox.body.data[0].description, /Người/);
  assert.doesNotMatch(
    JSON.stringify(inbox.body),
    new RegExp(a + "|" + b + "|notificationTokenHash"),
  );
  assert.deepEqual((await notices([secret()])).body.data, []);
  assert.equal((await notices([a])).body.data.length, 1);
  const pendingProfile = (await notices([a])).body.profiles;
  assert.equal(pendingProfile.length, 1);
  assert.equal(pendingProfile[0].fullName, "Người A");
  assert.equal(pendingProfile[0].member, null);
  assert.deepEqual((await notices([secret()])).body.profiles, []);
  const id = first.body.data.id;
  assert.equal(
    (await request(`/admin/registrations/${id}/approve`, "POST", {}, admin))
      .status,
    200,
  );
  assert.equal(
    (await request(`/admin/registrations/${id}/approve`, "POST", {}, admin))
      .status,
    409,
  );
  const mine = (await notices([a])).body.data;
  const ownProfile = (await notices([a])).body.profiles[0];
  assert.equal(ownProfile.status, "approved");
  assert.equal(ownProfile.member.name, "Người A");
  assert.ok(ownProfile.member.id);
  assert.ok(ownProfile.member.joinedAt);
  assert.equal(ownProfile.member.status, "active");
  assert.doesNotMatch(
    JSON.stringify(ownProfile),
    /notificationTokenHash|reviewedBy|zaloUserId/,
  );
  await app.locals.models.members.updateOne(
    { _id: ownProfile.member.id },
    { $set: { company: "Thông tin hệ thống đã sửa" } },
  );
  assert.equal(
    (await notices([a])).body.profiles[0].member.company,
    "Thông tin hệ thống đã sửa",
  );
  assert.equal(mine.length, 2);
  assert.equal(new Set(mine.map((n) => n.id)).size, 2);
  assert.ok(
    mine.some((n) => n.status === "approved" && /duyệt/.test(n.description)),
  );
  assert.equal((await notices([b])).body.data.length, 1);
  assert.equal(
    (
      await request(
        `/admin/registrations/${second.body.data.id}/reject`,
        "POST",
        { reason: "Cần bổ sung giấy tờ" },
        admin,
      )
    ).status,
    200,
  );
  assert.ok(
    (await notices([b])).body.data.some((n) =>
      n.description.includes("Cần bổ sung giấy tờ"),
    ),
  );
  assert.equal(
    (await notices([b])).body.profiles[0].rejectionReason,
    "Cần bổ sung giấy tờ",
  );
  assert.equal((await notices([b])).body.profiles[0].member, null);
  assert.ok(
    !(await notices([a])).body.data.some((n) =>
      n.description.includes("Cần bổ sung giấy tờ"),
    ),
  );
  assert.deepEqual((await notices([])).body.data, []);
  assert.equal((await notices(["not-a-token"])).status, 400);
  assert.equal(
    (await request("/admin/registration-inbox", "GET", undefined, admin)).body
      .pendingCount,
    0,
  );
});
test("failed approval transaction produces no phantom success notification", async () => {
  const token = secret();
  const sent = await submit(token, "Người C");
  const original = app.locals.models.members.create;
  try {
    app.locals.models.members.create = async () => {
      throw Error("Simulated database failure");
    };
    assert.equal(
      (
        await request(
          `/admin/registrations/${sent.body.data.id}/approve`,
          "POST",
          {},
          admin,
        )
      ).status,
      500,
    );
  } finally {
    app.locals.models.members.create = original;
  }
  const feed = (await notices([token])).body.data;
  assert.equal(feed.length, 1);
  assert.equal(feed[0].status, "pending");
  const row = await app.locals.models.registrations
    .findById(sent.body.data.id)
    .select("+notificationTokenHash")
    .lean();
  assert.notEqual(row.notificationTokenHash, token);
  assert.equal(row.status, "pending");
});
