const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { png } = require("./image-fixture.cjs");

test("public registration requires a real license image; documents persist privately and failed submissions clean up", async () => {
  const saved = { ...process.env };
  let mongo, app, server;
  const { createApp, listen, closeApp } = await import("../src/main.js");
  try {
    mongo = await MongoMemoryServer.create();
    const password = randomBytes(24).toString("hex");
    Object.assign(process.env, {
      VERCEL: "1",
      MONGODB_URI: mongo.getUri("license_test"),
      JWT_SECRET: randomBytes(48).toString("hex"),
      ADMIN_USERNAME: "license_admin",
      ADMIN_PASSWORD: password,
    });
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    let base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const send = async (path, body, token) => {
      const r = await fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const fields = {
      fullName: "Người đăng ký",
      company: "Doanh nghiệp A",
      phone: "0901234567",
      notificationToken: randomBytes(32).toString("hex"),
    };
    assert.equal((await send("/public/registrations", fields)).status, 400);
    assert.equal(
      (
        await send("/public/registrations", {
          ...fields,
          businessLicenseImage: "https://public.example/license.png",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send("/public/registrations", {
          ...fields,
          businessLicenseImage:
            "data:image/png;base64," +
            Buffer.from("not-a-real-image").toString("base64"),
        })
      ).status,
      400,
    );
    assert.equal(await app.locals.models.registrations.countDocuments(), 0);
    const bytes = png(400, 400);
    assert.ok(bytes.length > 256 * 1024);
    const businessLicenseImage =
      "data:image/png;base64," + bytes.toString("base64");
    const result = await send("/public/registrations", {
      ...fields,
      businessLicenseImage,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.data.id;
    assert.deepEqual(Object.keys(result.body.data).sort(), ["id", "status"]);
    const record = await app.locals.models.registrations.findById(id).lean();
    assert.ok(record.businessLicenseFileId);
    assert.equal(record.businessLicenseImage, undefined);
    const login = await send("/auth/admin-login", {
      username: "license_admin",
      password,
    });
    const token = login.body.data.accessToken;
    const url = "/admin/registrations/" + id + "/business-license";
    assert.equal((await fetch(base + url)).status, 401);
    assert.equal(
      (await fetch(base + "/public/registrations/" + id + "/business-license"))
        .status,
      404,
    );
    const detail = await (
      await fetch(base + "/admin/registrations/" + id, {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    assert.equal(detail.data.hasBusinessLicense, true);
    assert.equal(detail.data.businessLicenseFileId, undefined);
    const image = await fetch(base + url, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    const profiles = await send("/public/registration-notifications", {
      tokens: [fields.notificationToken],
    });
    assert.ok(
      !JSON.stringify(profiles.body).includes(record.businessLicenseFileId),
    );
    assert.ok(!JSON.stringify(profiles.body).includes("businessLicenseImage"));
    const service = app.locals.services.registrations,
      original = service.create;
    service.create = async () => {
      throw Error("write failed");
    };
    await assert.rejects(
      service.submitPublic({ ...fields, businessLicenseImage }),
      /write failed/,
    );
    service.create = original;
    assert.equal(
      await app.locals.db.db
        .collection("registration_documents.files")
        .countDocuments(),
      1,
    );
    const invalid = Buffer.alloc(1024 * 1024 + 1);
    Buffer.from("89504e470d0a1a0a", "hex").copy(invalid);
    await assert.rejects(
      service.businessLicenses.save(
        "too-large",
        "data:image/png;base64," + invalid.toString("base64"),
      ),
      /1 MiB/,
    );
    await closeApp(app, server);
    app = null;
    server = null;
    app = await createApp();
    server = await listen(app, 0, "127.0.0.1");
    base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const persisted = await fetch(base + url, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(persisted.status, 200);
    assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), bytes);
  } finally {
    if (app) await closeApp(app, server);
    if (mongo) await mongo.stop();
    process.env = saved;
  }
});
