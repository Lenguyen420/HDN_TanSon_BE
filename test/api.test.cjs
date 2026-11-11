const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let mongo, app, server, closeApp, base, accessToken, refreshToken;
const password = randomBytes(24).toString("base64url");
async function request(path, method = "GET", body, token = accessToken) {
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
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri("tanson_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "test_admin";
  process.env.ADMIN_PASSWORD = password;
  process.env.ADMIN_NAME = "Quản trị kiểm thử";
  const runtime = await import("../src/main.js");
  closeApp = runtime.closeApp;
  app = await runtime.createApp();
  server = await runtime.listen(
    app,
    process.env.TEST_FRONTEND_URL ? 4001 : 0,
    "127.0.0.1",
  );
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
});
test.after(async () => {
  if (app) await closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("API auth và hội viên hoạt động với MongoDB thật dùng riêng cho kiểm thử", async (t) => {
  await t.test("chặn truy cập hội viên khi chưa đăng nhập", async () => {
    assert.equal(
      (await request("/admin/members", "GET", undefined, null)).status,
      401,
    );
  });
  await t.test("từ chối sai mật khẩu", async () => {
    assert.equal(
      (
        await request(
          "/auth/admin-login",
          "POST",
          { username: "test_admin", password: "invalid-password" },
          null,
        )
      ).status,
      401,
    );
  });
  await t.test("đăng nhập thành công, không lộ hash mật khẩu", async () => {
    const r = await request(
      "/auth/admin-login",
      "POST",
      { username: "test_admin", password },
      null,
    );
    assert.equal(r.status, 200);
    accessToken = r.body.data.accessToken;
    refreshToken = r.body.data.refreshToken;
    assert.ok(accessToken && refreshToken);
    assert.equal(r.body.data.user.passwordHash, undefined);
    assert.equal(r.body.data.user.role, "SUPER_ADMIN");
  });
  const member = {
    id: "test-member",
    name: "Nguyễn Kiểm Thử",
    company: "Công ty kiểm thử",
    phone: "0900000001",
    email: "test@example.com",
    joinedAt: "2026-11-11",
    birthDate: "1990-01-01",
    isBoard: false,
    status: "active",
    position: "Hội viên",
  };
  await t.test(
    "kiểm tra dữ liệu, ngày không tồn tại và trường lạ",
    async () => {
      assert.equal(
        (
          await request("/admin/members", "POST", {
            ...member,
            joinedAt: "2026-02-30",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/admin/members", "POST", { ...member, isAdmin: true }))
          .status,
        400,
      );
      assert.equal(
        (await request("/admin/members", "POST", { ...member, name: "  " }))
          .status,
        400,
      );
    },
  );
  await t.test("tạo, xem, sửa hội viên và lọc Ban chấp hành", async () => {
    const created = await request("/admin/members", "POST", member);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.id, member.id);
    assert.equal(created.body.data.initials, "KT");
    assert.equal(
      (await request("/admin/members/test-member")).body.data.name,
      member.name,
    );
    assert.equal(
      (
        await request("/admin/members/test-member", "PUT", {
          ...member,
          isBoard: true,
          position: "Ủy viên Ban chấp hành",
        })
      ).status,
      200,
    );
    const list = await request(
      "/admin/members?isBoard=true&search=Ki%E1%BB%83m&limit=10&page=1",
    );
    assert.equal(list.body.pagination.total, 1);
    assert.equal(list.body.data[0].position, "Ủy viên Ban chấp hành");
    assert.equal(
      (await request("/admin/members?search=%5B.*%5D")).body.pagination.total,
      0,
    );
  });
  await t.test("nhập lại dữ liệu không ghi đè hồ sơ đang có", async () => {
    const r = await request("/admin/members/import", "POST", {
      members: [
        { ...member, name: "Không ghi đè" },
        { ...member, id: "imported-member" },
      ],
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.data, { imported: 1, skipped: 1 });
    assert.equal(
      (await request("/admin/members/test-member")).body.data.name,
      member.name,
    );
  });
  await t.test("xóa mềm và không tái tạo hồ sơ đã xóa qua import", async () => {
    assert.equal(
      (await request("/admin/members/test-member", "DELETE")).status,
      200,
    );
    assert.equal((await request("/admin/members/test-member")).status, 404);
    const r = await request("/admin/members/import", "POST", {
      members: [member],
    });
    assert.equal(r.body.data.imported, 0);
    assert.equal((await request("/admin/members")).body.pagination.total, 1);
  });

  await t.test(
    "hồ sơ công khai chỉ tạo pending, không cho tự cấp quyền hoặc xem danh sách",
    async () => {
      assert.equal(
        (await request("/admin/registrations", "GET", undefined, null)).status,
        401,
      );
      const dto = {
        fullName: "Ứng viên công khai",
        company: "Công ty mẫu",
        phone: "0900000002",
      };
      assert.equal(
        (
          await request(
            "/public/registrations",
            "POST",
            { ...dto, status: "approved", isBoard: true },
            null,
          )
        ).status,
        400,
      );
      const r = await request("/public/registrations", "POST", dto, null);
      assert.equal(r.status, 201);
      assert.equal(r.body.data.status, "pending");
      assert.deepEqual(Object.keys(r.body.data).sort(), ["id", "status"]);
    },
  );
  await t.test(
    "duyệt đồng thời chỉ tạo một hội viên và lưu người duyệt",
    async () => {
      const dto = {
        id: "registration-race",
        fullName: "Hội viên từ hồ sơ",
        company: "Công ty phê duyệt",
        phone: "0900000003",
        date: "2026-11-11",
      };
      assert.equal(
        (await request("/admin/registrations", "POST", dto)).status,
        201,
      );
      assert.equal(
        (await request("/admin/registrations?status=pending&search=ph%C3%AA"))
          .body.pagination.total,
        1,
      );
      const results = await Promise.all([
        request("/admin/registrations/registration-race/approve", "POST", {}),
        request("/admin/registrations/registration-race/approve", "POST", {}),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const registration = (
        await request("/admin/registrations/registration-race")
      ).body.data;
      assert.equal(registration.status, "approved");
      assert.ok(
        registration.reviewedBy &&
          registration.reviewedAt &&
          registration.memberId,
      );
      const member = (await request("/admin/members/" + registration.memberId))
        .body.data;
      assert.equal(member.sourceRegistrationId, dto.id);
      assert.equal(member.isBoard, false);
      assert.equal(member.name, dto.fullName);
      assert.equal(
        (
          await request(
            "/admin/members?search=H%E1%BB%99i%20vi%C3%AAn%20t%E1%BB%AB",
          )
        ).body.pagination.total,
        1,
      );
      assert.equal(
        (await request("/admin/registrations/registration-race", "PUT", dto))
          .status,
        409,
      );
      assert.equal(
        (
          await request(
            "/admin/registrations/registration-race/reject",
            "POST",
            { reason: "Không được sửa kết quả" },
          )
        ).status,
        409,
      );
      assert.equal(
        (await request("/admin/registrations/registration-race", "DELETE"))
          .status,
        409,
      );
    },
  );
  await t.test("lỗi tạo hội viên hoàn tác kết quả duyệt hồ sơ", async () => {
    const dto = {
      id: "registration-rollback",
      fullName: "Kiểm thử hoàn tác",
      company: "Công ty kiểm thử",
      phone: "0900000004",
      date: "2026-11-11",
    };
    await request("/admin/registrations", "POST", dto);
    const model = app.locals.models.members;
    const original = model.create;
    model.create = async () => {
      throw new Error("Simulated storage failure");
    };
    try {
      assert.equal(
        (
          await request(
            "/admin/registrations/registration-rollback/approve",
            "POST",
            {},
          )
        ).status,
        500,
      );
    } finally {
      model.create = original;
    }
    const registration = (
      await request("/admin/registrations/registration-rollback")
    ).body.data;
    assert.equal(registration.status, "pending");
    assert.equal(registration.memberId, undefined);
    assert.equal(
      (
        await request(
          "/admin/registrations/registration-rollback/approve",
          "POST",
          {},
        )
      ).status,
      200,
    );
  });
  await t.test(
    "từ chối lưu lý do, không sinh hội viên; hồ sơ pending được sửa và xóa mềm",
    async () => {
      const dto = {
        id: "registration-reject",
        fullName: "Hồ sơ từ chối",
        company: "Công ty mẫu",
        phone: "0900000005",
        date: "2026-11-11",
      };
      await request("/admin/registrations", "POST", dto);
      assert.equal(
        (
          await request("/admin/registrations/registration-reject", "PUT", {
            ...dto,
            fullName: "Hồ sơ đã sửa",
          })
        ).status,
        200,
      );
      const r = await request(
        "/admin/registrations/registration-reject/reject",
        "POST",
        { reason: "Thiếu thông tin" },
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.data.rejectionReason, "Thiếu thông tin");
      assert.ok(r.body.data.reviewedBy);
      assert.equal(r.body.data.memberId, undefined);
      assert.equal(
        (
          await request(
            "/admin/registrations/registration-reject/approve",
            "POST",
            {},
          )
        ).status,
        409,
      );
      assert.equal(
        (await request("/admin/registrations/registration-reject", "DELETE"))
          .status,
        200,
      );
      assert.equal(
        (await request("/admin/registrations/registration-reject")).status,
        404,
      );
    },
  );
  await t.test(
    "chuyển hồ sơ cũ giữ trạng thái, không ghi đè và không tạo lại hồ sơ đã xóa",
    async () => {
      const dto = {
        id: "registration-import",
        fullName: "Hồ sơ chuyển đổi",
        company: "Công ty mẫu",
        phone: "0900000006",
        date: "2026-11-11",
      };
      let r = await request("/admin/registrations/import", "POST", {
        registrations: [
          dto,
          { ...dto, id: "registration-race", fullName: "Không ghi đè" },
        ],
      });
      assert.deepEqual(r.body.data, { imported: 1, skipped: 1, failed: [] });
      await request("/admin/registrations/registration-import", "DELETE");
      r = await request("/admin/registrations/import", "POST", {
        registrations: [dto],
      });
      assert.equal(r.body.data.skipped, 1);
      r = await request("/admin/registrations/import", "POST", {
        registrations: [
          { ...dto, id: "legacy-approved-missing", status: "approved" },
        ],
      });
      assert.equal(r.body.data.failed.length, 1);
      const existing = (await request("/admin/members/imported-member")).body
        .data;
      r = await request("/admin/registrations/import", "POST", {
        registrations: [
          {
            ...dto,
            id: "legacy-approved",
            status: "approved",
            memberId: existing.id,
          },
        ],
      });
      assert.equal(r.body.data.imported, 1);
      assert.equal(
        (await request("/admin/registrations/legacy-approved")).body.data
          .memberId,
        existing.id,
      );
    },
  );

  await t.test(
    "tương thích mật khẩu scrypt cũ, nâng cấp bcrypt và giữ JWT/phiên cũ",
    async () => {
      const { scryptSync, createHash } = require("node:crypto");
      const jwt = require("jsonwebtoken");
      const legacyPassword = randomBytes(64).toString("base64url");
      const salt = randomBytes(16).toString("hex");
      const hash =
        salt + ":" + scryptSync(legacyPassword, salt, 64).toString("hex");
      await app.locals.models.admins.create({
        _id: "legacy-admin",
        username: "legacy_admin",
        passwordHash: hash,
        name: "Tài khoản cũ",
        role: "STAFF",
        active: true,
      });
      const legacyRefresh = randomBytes(48).toString("base64url");
      await app.locals.models.sessions.create({
        _id: "legacy-session",
        userId: "legacy-admin",
        tokenHash: createHash("sha256").update(legacyRefresh).digest("hex"),
        expiresAt: new Date(Date.now() + 60000),
      });
      const oldToken = jwt.sign(
        { sub: "legacy-admin", sid: "legacy-session" },
        process.env.JWT_SECRET,
        {
          expiresIn: 900,
          issuer: "tanson-backend",
          audience: "tanson-admin",
          algorithm: "HS256",
        },
      );
      assert.equal(
        (await request("/auth/me", "GET", undefined, oldToken)).status,
        200,
      );
      const login = await request(
        "/auth/admin-login",
        "POST",
        { username: "legacy_admin", password: legacyPassword },
        null,
      );
      assert.equal(login.status, 200);
      const stored = await app.locals.models.admins
        .findById("legacy-admin")
        .select("+passwordHash")
        .lean();
      assert.ok(stored.passwordHash.startsWith("bcrypt-sha256:$2"));
      assert.equal(
        (
          await request(
            "/auth/admin-login",
            "POST",
            { username: "legacy_admin", password: legacyPassword },
            null,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            "/auth/refresh",
            "POST",
            { refreshToken: legacyRefresh },
            null,
          )
        ).status,
        200,
      );
    },
  );
  await t.test(
    "Express từ chối đầu vào NoSQL và query lạ, trả JSON 404",
    async () => {
      assert.equal(
        (
          await request(
            "/auth/admin-login",
            "POST",
            { username: { $ne: null }, password: "invalid" },
            null,
          )
        ).status,
        400,
      );
      assert.equal(
        (await request("/admin/members?status%5B%24ne%5D=inactive")).status,
        400,
      );
      const r = await request("/missing-api");
      assert.equal(r.status, 404);
      assert.equal(r.body.statusCode, 404);
    },
  );
  await t.test("refresh xoay token, token cũ không dùng lại được", async () => {
    const old = refreshToken;
    const r = await request(
      "/auth/refresh",
      "POST",
      { refreshToken: old },
      null,
    );
    assert.equal(r.status, 200);
    accessToken = r.body.data.accessToken;
    refreshToken = r.body.data.refreshToken;
    assert.notEqual(refreshToken, old);
    assert.equal(
      (await request("/auth/refresh", "POST", { refreshToken: old }, null))
        .status,
      401,
    );
  });
  await t.test("đăng xuất thu hồi cả refresh và access token", async () => {
    assert.equal(
      (await request("/auth/logout", "POST", { refreshToken }, null)).status,
      200,
    );
    assert.equal((await request("/auth/me")).status, 401);
    assert.equal(
      (await request("/auth/refresh", "POST", { refreshToken }, null)).status,
      401,
    );
  });
});

test(
  "Next.js nối Express bằng cookie HttpOnly và CRUD hội viên",
  { skip: !process.env.TEST_FRONTEND_URL },
  async () => {
    const origin = process.env.TEST_FRONTEND_URL;
    const cookies = new Map();
    async function frontend(path, method = "GET", body, options = {}) {
      const r = await fetch(origin + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: [...cookies]
            .map(([key, value]) => key + "=" + value)
            .join("; "),
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const value of r.headers.getSetCookie()) {
        assert.ok(value.toLowerCase().includes("httponly"));
        const [pair] = value.split(";");
        const [key, ...rest] = pair.split("=");
        cookies.set(key, rest.join("="));
      }
      return { status: r.status, body: await r.json() };
    }
    const login = await frontend("/api/auth/admin-login", "POST", {
      username: "test_admin",
      password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.accessToken, undefined);
    assert.equal(login.body.data.refreshToken, undefined);
    assert.ok(cookies.get("admin_access_token"));
    assert.equal(
      (await frontend("/api/auth/me")).body.data.username,
      "test_admin",
    );
    assert.equal(
      (
        await frontend(
          "/api/association/members",
          "POST",
          {},
          { headers: { Origin: "https://untrusted.example" } },
        )
      ).status,
      403,
    );
    const member = {
      id: "frontend-e2e-member",
      name: "Hội viên qua giao diện",
      company: "Kiểm thử kết nối",
      joinedAt: "2026-11-11",
    };
    assert.equal(
      (await frontend("/api/association/members", "POST", member)).status,
      201,
    );
    assert.equal(
      (
        await frontend("/api/association/members/frontend-e2e-member", "PUT", {
          ...member,
          isBoard: true,
        })
      ).status,
      200,
    );
    const list = await frontend("/api/association/members?isBoard=true");
    assert.ok(list.body.data.some((item) => item.id === member.id));

    const registration = {
      id: "frontend-e2e-registration",
      fullName: "Hồ sơ qua giao diện",
      company: "Kiểm thử hồ sơ",
      phone: "0900000007",
      date: "2026-11-11",
    };
    assert.equal(
      (await frontend("/api/association/registrations", "POST", registration))
        .status,
      201,
    );
    assert.ok(
      (await frontend("/api/association/registrations")).body.data.some(
        (item) => item.id === registration.id,
      ),
    );
    const approved = await frontend(
      "/api/association/registrations/" + registration.id + "/approve",
      "POST",
      {},
    );
    assert.equal(approved.status, 200);
    assert.ok(approved.body.data.memberId);
    assert.equal(
      (
        await frontend(
          "/api/association/registrations/" + registration.id + "/approve",
          "POST",
          {},
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await frontend("/api/association/registrations", "POST", {
          ...registration,
          id: "frontend-e2e-reject",
        })
      ).status,
      201,
    );
    const rejected = await frontend(
      "/api/association/registrations/frontend-e2e-reject/reject",
      "POST",
      { reason: "Thiếu hồ sơ" },
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.rejectionReason, "Thiếu hồ sơ");
    assert.equal((await frontend("/api/auth/refresh", "POST")).status, 200);
    assert.equal(
      (await frontend("/api/association/members/frontend-e2e-member", "DELETE"))
        .status,
      200,
    );
    assert.equal((await frontend("/api/auth/logout", "POST")).status, 200);
    assert.equal(cookies.get("admin_access_token"), "");
    assert.equal((await frontend("/api/association/members")).status, 401);
  },
);
