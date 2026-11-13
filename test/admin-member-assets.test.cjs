const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { png } = require("./image-fixture.cjs");

test("admin adds members and registrations with local avatar/license images; files remain private and survive editing/approval", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const password = randomBytes(24).toString("hex");
    Object.assign(process.env, {
      VERCEL: "1",
      MONGODB_URI: mongo.getUri("admin_member_assets"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "asset_admin",
      ADMIN_PASSWORD: password,
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    let token;
    const req = async (path, method = "GET", body) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    token = (
      await req("/auth/admin-login", "POST", {
        username: "asset_admin",
        password,
      })
    ).body.data.accessToken;
    const bytes = png(400, 400),
      paper = png(2, 2);
    const avatar = "data:image/png;base64," + bytes.toString("base64"),
      businessLicenseImage =
        "data:image/png;base64," + paper.toString("base64");
    const dto = {
      id: "member-from-admin",
      name: "Hội viên thêm từ máy",
      company: "Doanh nghiệp",
      joinedAt: "2020-01-01",
      avatar,
      businessLicenseImage,
    };
    const added = await req("/admin/members", "POST", dto);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.match(added.body.data.avatar, /^uploads\/members\/.+\.png$/);
    assert.equal(added.body.data.hasBusinessLicense, true);
    assert.equal(added.body.data.businessLicenseFileId, undefined);
    assert.equal(added.body.data.businessLicenseImage, undefined);
    const picture = await fetch(
      base.replace("/api/v1", "") + "/" + added.body.data.avatar,
    );
    assert.equal(picture.status, 200);
    assert.deepEqual(Buffer.from(await picture.arrayBuffer()), bytes);
    const privateUrl = "/admin/members/" + dto.id + "/business-license";
    assert.equal((await fetch(base + privateUrl)).status, 401);
    const license = await fetch(base + privateUrl, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(license.status, 200);
    assert.deepEqual(Buffer.from(await license.arrayBuffer()), paper);
    const beforeImages = await app.locals.db.db
        .collection("images.files")
        .countDocuments(),
      beforeDocs = await app.locals.db.db
        .collection("registration_documents.files")
        .countDocuments();
    assert.equal((await req("/admin/members", "POST", dto)).status, 409);
    assert.equal(
      await app.locals.db.db.collection("images.files").countDocuments(),
      beforeImages,
    );
    assert.equal(
      await app.locals.db.db
        .collection("registration_documents.files")
        .countDocuments(),
      beforeDocs,
    );
    const edited = await req("/admin/members/" + dto.id, "PUT", {
      name: dto.name,
      company: "Đã sửa",
      joinedAt: dto.joinedAt,
      avatar: added.body.data.avatar,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.hasBusinessLicense, true);
    assert.equal(
      (await req("/admin/members")).body.data[0].hasBusinessLicense,
      true,
    );
    const pub = await req("/public/members");
    assert.ok(!JSON.stringify(pub.body).includes("businessLicense"));
    const registration = {
      id: "registration-from-admin",
      fullName: "Đăng ký từ admin",
      company: "Doanh nghiệp mới",
      phone: "0901234567",
      date: "2020-01-01",
      avatar,
      businessLicenseImage,
    };
    const addedRegistration = await req(
      "/admin/registrations",
      "POST",
      registration,
    );
    assert.equal(addedRegistration.status, 201);
    assert.equal(addedRegistration.body.data.hasBusinessLicense, true);
    const approved = await req(
      "/admin/registrations/registration-from-admin/approve",
      "POST",
      {},
    );
    assert.equal(approved.status, 200);
    const memberId = approved.body.data.memberId;
    const member = await req("/admin/members/" + memberId);
    assert.equal(member.body.data.hasBusinessLicense, true);
    const transferred = await fetch(
      base + "/admin/members/" + memberId + "/business-license",
      { headers: { Authorization: "Bearer " + token } },
    );
    assert.equal(transferred.status, 200);
    assert.deepEqual(Buffer.from(await transferred.arrayBuffer()), paper);
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
