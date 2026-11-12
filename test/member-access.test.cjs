const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
let mongo, app, server, runtime, base;
const request = async (path, token) => {
  const response = await fetch(base + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
};
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("member_access_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "";
  process.env.ADMIN_PASSWORD = "";
  runtime = await import("../src/main.js");
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  app.locals.services.memberAccess.transport = async (url, options) => {
    assert.equal(url, "https://graph.zalo.me/v2.0/me?fields=id");
    const token = options.headers.access_token;
    if (token === "offline") throw Error("offline");
    return {
      ok: token !== "invalid",
      json: async () =>
        token === "invalid"
          ? { error: -124 }
          : { id: token === "linked" ? "123456789" : "987654321" },
    };
  };
  await app.locals.models.members.create([
    {
      _id: "active-member",
      name: "Hội viên A [Tân Sơn]",
      company: "Doanh nghiệp A",
      joinedAt: "2026-01-01",
      zaloUserId: "123456789",
      phone: "0900000001",
      email: "private@example.com",
      birthDate: "1990-01-01",
      companyAddress: "Địa chỉ riêng",
      status: "active",
    },
    {
      _id: "inactive-member",
      name: "Hội viên B",
      company: "Doanh nghiệp B",
      joinedAt: "2026-01-01",
      status: "inactive",
    },
    {
      _id: "deleted-member",
      name: "Hội viên C",
      company: "Doanh nghiệp C",
      joinedAt: "2026-01-01",
      deletedAt: new Date(),
    },
  ]);
});
test.after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("member APIs reject missing/invalid tokens and keep admin protected", async () => {
  assert.equal((await request("/member/members")).status, 401);
  assert.equal((await request("/member/identity", "invalid")).status, 401);
  assert.equal((await request("/admin/members", "linked")).status, 401);
  assert.equal((await request("/public/members")).status, 404);
  assert.equal((await request("/member/identity", "offline")).status, 503);
});
test("Zalo identity must be linked to an active member", async () => {
  const identity = await request("/member/identity", "unlinked");
  assert.equal(identity.status, 200);
  assert.equal(identity.body.data.linked, false);
  assert.equal(identity.body.data.zaloUserId, "987654321");
  assert.equal(identity.body.data.member, null);
  assert.equal((await request("/member/members", "unlinked")).status, 403);
});
test("linked identity sees own profile and only safe active directory fields", async () => {
  const identity = await request("/member/identity", "linked");
  assert.equal(identity.body.data.member.id, "active-member");
  assert.equal(identity.body.data.member.phone, "0900000001");
  const result = await request(
    "/member/members?page=1&limit=100&search=%5BT%C3%A2n%20S%C6%A1n%5D",
    "linked",
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.pagination.total, 1);
  assert.equal(result.body.data[0].id, "active-member");
  for (const field of [
    "phone",
    "email",
    "birthDate",
    "companyAddress",
    "joinedAt",
    "zaloUserId",
    "sourceRegistrationId",
    "deletedAt",
  ])
    assert.equal(result.body.data[0][field], undefined);
  assert.equal(result.headers.get("cache-control"), "no-store");
});
test("revoking membership blocks the next directory request", async () => {
  await app.locals.models.members.updateOne(
    { _id: "active-member" },
    { $set: { status: "inactive" } },
  );
  assert.equal((await request("/member/members", "linked")).status, 403);
});
test("a Zalo account cannot link to two member profiles", async () => {
  await assert.rejects(
    app.locals.models.members.updateOne(
      { _id: "inactive-member" },
      { $set: { zaloUserId: "123456789" } },
    ),
    (error) => error.code === 11000,
  );
});

test("consented sessions save Zalo accounts and link only verified unique phone matches", async (t) => {
  const oldTransport = app.locals.services.memberAccess.transport;
  app.locals.services.memberAccess.transport = async (url, options) => {
    if (url.endsWith("fields=id,name,picture")) {
      const ids = {
        auto: "222222",
        unmatched: "333333",
        ambiguous: "444444",
        denied: "555555",
        noSecret: "666666",
        conflict: "777777",
      };
      return {
        ok: true,
        json: async () => ({
          id: ids[options.headers.access_token],
          ...(options.headers.access_token === "denied"
            ? {}
            : {
                name: "Tên Zalo xác minh",
                picture: { data: { url: "https://example.com/avatar.jpg" } },
              }),
        }),
      };
    }
    if (url.endsWith("/me/info")) {
      assert.equal(options.headers.secret_key, "test-secret-not-real");
      const phones = {
        "auto-proof": "84900000002",
        "unmatched-proof": "84900000009",
        "ambiguous-proof": "84900000004",
        "conflict-proof": "84900000005",
      };
      return {
        ok: true,
        json: async () =>
          phones[options.headers.code]
            ? { data: { number: phones[options.headers.code] } }
            : { error: -1 },
      };
    }
    return oldTransport(url, options);
  };
  process.env.ZALO_APP_SECRET = "test-secret-not-real";
  const session = async (token, body = {}) => {
    const response = await fetch(base + "/member/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await app.locals.models.members.create([
    {
      _id: "phone-match",
      name: "Hội viên tự nhận diện",
      company: "A",
      joinedAt: "2026-01-01",
      phone: "+84 900 000 002",
    },
    {
      _id: "ambiguous-a",
      name: "A",
      company: "A",
      joinedAt: "2026-01-01",
      phone: "0900000004",
    },
    {
      _id: "ambiguous-b",
      name: "B",
      company: "B",
      joinedAt: "2026-01-01",
      phone: "0900000004",
    },
    {
      _id: "already-linked",
      name: "C",
      company: "C",
      joinedAt: "2026-01-01",
      phone: "0900000005",
      zaloUserId: "888888",
    },
  ]);
  await t.test(
    "explicit consent session upserts profile once and never creates membership",
    async () => {
      const before = await app.locals.models.members.countDocuments();
      await Promise.all([session("unmatched"), session("unmatched")]);
      assert.equal(
        await app.locals.models.zaloUsers.countDocuments({ _id: "333333" }),
        1,
      );
      const account = await app.locals.models.zaloUsers
        .findById("333333")
        .lean();
      assert.equal(account.name, "Tên Zalo xác minh");
      assert.equal(account.avatar, "https://example.com/avatar.jpg");
      assert.ok(account.profileConsentAt);
      assert.equal(account.accessToken, undefined);
      assert.equal(await app.locals.models.members.countDocuments(), before);
    },
  );
  await t.test(
    "verified phone auto links and repeated sessions preserve membership",
    async () => {
      const result = await session("auto", { phoneToken: "auto-proof" });
      assert.equal(result.status, 200);
      assert.equal(result.body.data.linked, true);
      assert.equal(result.body.data.member.id, "phone-match");
      assert.equal(result.body.data.user.phone, "0900000002");
      assert.equal(
        (await app.locals.models.members.findById("phone-match").lean())
          .zaloUserId,
        "222222",
      );
      assert.equal(
        (await session("auto", { phoneToken: "auto-proof" })).body.data.member
          .id,
        "phone-match",
      );
    },
  );
  await t.test(
    "unmatched/ambiguous/conflicting phones do not grant member access",
    async () => {
      assert.equal(
        (await session("unmatched", { phoneToken: "unmatched-proof" })).body
          .data.linked,
        false,
      );
      assert.equal(
        (await session("ambiguous", { phoneToken: "ambiguous-proof" })).body
          .data.linked,
        false,
      );
      assert.equal(
        (await session("conflict", { phoneToken: "conflict-proof" })).body.data
          .linked,
        false,
      );
      assert.equal(
        (await app.locals.models.members.findById("already-linked").lean())
          .zaloUserId,
        "888888",
      );
    },
  );
  await t.test(
    "no profile consent, forged phone and invalid phone proof are rejected",
    async () => {
      assert.equal((await session("denied")).status, 403);
      assert.equal(
        await app.locals.models.zaloUsers.countDocuments({ _id: "555555" }),
        0,
      );
      assert.equal(
        (
          await session("unmatched", {
            phone: "0900000002",
            zaloUserId: "222222",
          })
        ).status,
        400,
      );
      assert.equal(
        (await session("unmatched", { phoneToken: "invalid" })).status,
        400,
      );
    },
  );
  await t.test(
    "missing phone secret still saves the allowed profile without auto linking",
    async () => {
      delete process.env.ZALO_APP_SECRET;
      const result = await session("noSecret", { phoneToken: "auto-proof" });
      assert.equal(result.status, 200);
      assert.match(result.body.data.phoneNotice, /chưa cấu hình/);
      assert.equal(result.body.data.linked, false);
      assert.equal(result.body.data.user.phone, null);
      assert.equal(
        await app.locals.models.zaloUsers.countDocuments({ _id: "666666" }),
        1,
      );
    },
  );
});
