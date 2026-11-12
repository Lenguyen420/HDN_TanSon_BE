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

test("receipt owner edits personal information atomically without changing membership privileges", async () => {
  const token = secret();
  const sent = await submit(token, "Người D");
  const id = sent.body.data.id;
  const path = `/public/registration-profile/${id}`;
  const fields = {
    tokens: [token],
    fullName: "Tên cập nhật",
    company: "Công ty mới",
    phone: "0900000002",
    email: "new@example.com",
    birthDate: "1990-01-01",
    jobTitle: "Giám đốc",
    companyAddress: "Tân Sơn",
    taxCode: "123456",
  };
  const pending = await request(path, "PUT", fields);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.profiles[0].fullName, fields.fullName);
  assert.equal(pending.body.profiles[0].status, "pending");
  assert.equal(
    (await request(path, "PUT", { ...fields, tokens: [secret()] })).status,
    404,
  );
  for (const extra of [
    { status: "approved" },
    { isBoard: true },
    { memberId: "another-member" },
  ])
    assert.equal(
      (await request(path, "PUT", { ...fields, ...extra })).status,
      400,
    );
  assert.equal(
    (await request(`/admin/registrations/${id}/approve`, "POST", {}, admin))
      .status,
    200,
  );
  const saved = await request(path, "PUT", {
    ...fields,
    fullName: "Tên hội viên mới",
    email: "",
    taxCode: "654321",
  });
  assert.equal(saved.status, 200);
  const profile = saved.body.profiles[0];
  assert.equal(profile.member.name, "Tên hội viên mới");
  assert.equal(profile.member.email, "");
  assert.equal(profile.taxCode, "654321");
  assert.equal(profile.member.isBoard, false);
  assert.equal(profile.member.position, "Hội viên");
  const original = app.locals.models.members.findOneAndUpdate;
  try {
    app.locals.models.members.findOneAndUpdate = () => {
      throw Error("Simulated update failure");
    };
    assert.equal(
      (await request(path, "PUT", { ...fields, fullName: "Must roll back" }))
        .status,
      500,
    );
  } finally {
    app.locals.models.members.findOneAndUpdate = original;
  }
  assert.equal(
    (await app.locals.models.registrations.findById(id).lean()).fullName,
    "Tên hội viên mới",
  );
  assert.equal(
    (await app.locals.models.members.findById(profile.member.id).lean()).name,
    "Tên hội viên mới",
  );
});

test("registration portrait reaches member directories and legacy portrait sync requires the receipt", async () => {
  const token = secret();
  const avatar = "https://example.com/sdk-avatar.jpg";
  const sent = await request("/public/registrations", "POST", {
    notificationToken: token,
    fullName: "Hội viên có ảnh",
    company: "Doanh nghiệp",
    phone: "0900000005",
    avatar,
  });
  assert.equal(sent.status, 201);
  const id = sent.body.data.id;
  const approval = await request(
    `/admin/registrations/${id}/approve`,
    "POST",
    {},
    admin,
  );
  assert.equal(approval.status, 200);
  const memberId = approval.body.data.memberId;
  const publicMembers = await request("/public/members?limit=100");
  assert.equal(
    publicMembers.body.data.find((member) => member.id === memberId).avatar,
    avatar,
  );
  await app.locals.models.members.updateOne(
    { _id: memberId },
    { $set: { avatar: "", isBoard: true } },
  );
  await app.locals.models.registrations.updateOne(
    { _id: id },
    { $set: { avatar: "" } },
  );
  const endpoint = `/public/registration-avatar/${id}`;
  assert.equal(
    (await request(endpoint, "PUT", { tokens: [secret()], avatar })).status,
    404,
  );
  assert.equal(
    (
      await request(endpoint, "PUT", {
        tokens: [token],
        avatar: "javascript:alert(1)",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(endpoint, "PUT", { tokens: [token], avatar })).status,
    200,
  );
  assert.equal(
    (await app.locals.models.members.findById(memberId).lean()).avatar,
    avatar,
  );
  await app.locals.models.members.updateOne(
    { _id: memberId },
    { $set: { avatar: "https://example.com/admin-portrait.jpg" } },
  );
  assert.equal(
    (
      await request(endpoint, "PUT", {
        tokens: [token],
        avatar: "https://example.com/new-sdk.jpg",
      })
    ).status,
    200,
  );
  const member = await app.locals.models.members.findById(memberId).lean();
  assert.equal(member.avatar, "https://example.com/admin-portrait.jpg");
  assert.equal(member.isBoard, true);
  assert.equal(
    (await request("/public/members?isBoard=true&limit=100")).body.data.find(
      (item) => item.id === memberId,
    ).avatar,
    member.avatar,
  );
});
