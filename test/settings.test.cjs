const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { MongoMemoryServer } = require("mongodb-memory-server");
let mongo, runtime, app, server, base, token, adminId, uploadDirectory;
const password = randomBytes(24).toString("base64url");
const values = {
  name: "Hội Doanh nghiệp kiểm thử",
  slogan: "Kết nối - Phát triển",
  introduction: "Giới thiệu hoạt động của Hội.\nĐồng hành cùng doanh nghiệp.",
  mission: "Hỗ trợ cộng đồng doanh nghiệp",
  department: "Ban thư ký",
  address: "Phường Tân Sơn",
  hours: "Thứ hai - thứ sáu, 08:00 - 17:00",
  phone: "+84 900 000 001",
  email: "contact@example.com",
  zaloUrl: "https://zalo.me/123456789",
  assistantGreeting: "Xin chào! Tôi có thể giúp gì cho bạn?",
  assistantQuestions:
    "Đăng ký ở đâu? | Tại mục Sự kiện.\n\nLiên hệ ai? | Ban thư ký | Hội.",
};
async function request(path, method = "GET", body, auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}
async function start() {
  app = await runtime.createApp({ uploadDirectory });
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
}
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("tanson_settings_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "settings_admin";
  process.env.ADMIN_PASSWORD = password;
  process.env.ADMIN_NAME = "Quản trị cấu hình kiểm thử";
  uploadDirectory = await mkdtemp(join(tmpdir(), "tanson-settings-"));
  runtime = await import("../src/main.js");
  await start();
  const login = await request(
    "/auth/admin-login",
    "POST",
    { username: "settings_admin", password },
    null,
  );
  assert.equal(login.status, 200);
  token = login.body.data.accessToken;
  adminId = login.body.data.user.id;
});
test.after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
  if (uploadDirectory) {
    assert.ok(
      resolve(uploadDirectory).startsWith(
        resolve(tmpdir()) + sep + "tanson-settings-",
      ),
    );
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});

test("GET cấu hình mặc định không tạo dữ liệu giả hoặc ghi database, yêu cầu quyền khi quản trị", async () => {
  assert.equal(
    (await request("/admin/settings", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (await request("/admin/settings", "PUT", values, null)).status,
    401,
  );
  const pub = await request("/public/settings", "GET", undefined, null);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("cache-control"), "no-store");
  assert.equal(pub.body.data.id, "association");
  assert.equal(pub.body.data.phone, "");
  assert.equal(pub.body.data.email, "");
  assert.equal(pub.body.data.assistantQuestions, "");
  assert.equal(pub.body.data.updatedBy, undefined);
  assert.equal((await request("/admin/settings")).body.data.updatedAt, null);
  assert.equal(await app.locals.models.settings.countDocuments(), 0);
});

test("hai lần lưu đầu đồng thời vẫn chỉ có một cấu hình, lưu được mọi nhóm và người sửa", async () => {
  const results = await Promise.all([
    request("/admin/settings", "PUT", { ...values, name: "Hội thứ nhất" }),
    request("/admin/settings", "PUT", values),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.equal(await app.locals.models.settings.countDocuments(), 1);
  const updated = await request("/admin/settings", "PUT", {
    ...values,
    name: "  " + values.name + "  ",
  });
  assert.equal(updated.status, 200);
  for (const [key, value] of Object.entries(values))
    assert.equal(updated.body.data[key], value, key);
  assert.equal(updated.body.data.updatedBy, adminId);
  assert.ok(updated.body.data.updatedAt);
  assert.equal(updated.body.data._id, undefined);
  const stored = await app.locals.models.settings
    .findById("association")
    .lean();
  assert.equal(stored.assistantQuestions, values.assistantQuestions);
  assert.equal(stored.updatedBy, adminId);
  const pub = await request("/public/settings", "GET", undefined, null);
  for (const [key, value] of Object.entries(values))
    assert.equal(pub.body.data[key], value);
  for (const key of ["updatedAt", "updatedBy", "createdAt", "_id", "__v"])
    assert.equal(pub.body.data[key], undefined);
});

test("từ chối dữ liệu sai và trường ngoài cấu hình mà không thay đổi bản đã lưu", async () => {
  for (const invalid of [
    { name: " " },
    { slogan: "" },
    { name: { $ne: "" } },
    { email: "invalid-email" },
    { phone: "not a phone" },
    { zaloUrl: "https://" },
    { zaloUrl: "http://zalo.me/example" },
    { zaloUrl: "javascript:alert(1)" },
    { zaloUrl: "https://user:password@example.com" },
    { assistantQuestions: "Câu hỏi thiếu trả lời" },
    { assistantQuestions: "| Trả lời" },
    { assistantQuestions: "Câu hỏi |   " },
    { assistantQuestions: Array(101).fill("Hỏi | Đáp").join("\n") },
    { introduction: "a".repeat(20_001) },
    { id: "other-association" },
    { updatedBy: "forged-admin" },
    { updatedAt: "2026-01-01" },
    { role: "SUPER_ADMIN" },
    { logo: "data:image/png;base64,AAAA" },
  ])
    assert.equal(
      (await request("/admin/settings", "PUT", { ...values, ...invalid }))
        .status,
      400,
    );
  assert.equal((await request("/admin/settings", "PUT", {})).status, 400);
  assert.equal(
    (await request("/admin/settings?name%5B%24ne%5D=test")).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/public/settings?includePrivate=true",
        "GET",
        undefined,
        null,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/public/settings", "PUT", values, null)).status,
    404,
  );
  assert.equal((await request("/admin/settings", "DELETE")).status, 404);
  assert.equal((await request("/admin/settings/other-id")).status, 404);
  assert.equal((await request("/admin/settings")).body.data.name, values.name);
});

test("PUT xóa được trường tùy chọn và dữ liệu còn nguyên sau khi tạo lại app", async () => {
  const cleared = await request("/admin/settings", "PUT", {
    name: values.name,
    slogan: values.slogan,
  });
  assert.equal(cleared.status, 200);
  for (const key of Object.keys(values).filter(
    (key) => !["name", "slogan"].includes(key),
  ))
    assert.equal(cleared.body.data[key], "");
  const snapshot = cleared.body.data;
  await runtime.closeApp(app, server);
  app = server = undefined;
  await start();
  assert.deepEqual((await request("/admin/settings")).body.data, snapshot);
  assert.equal(
    (await request("/public/settings", "GET", undefined, null)).body.data.name,
    values.name,
  );
  assert.equal(await app.locals.models.settings.countDocuments(), 1);
});

test("introduction video URL persists in MongoDB, survives old admin saves and can be cleared", async () => {
  const url = "https://cdn.example.com/gioi-thieu.mp4";
  assert.equal(
    (
      await request(
        "/admin/settings",
        "PUT",
        { ...values, introductionVideoUrl: url },
        null,
      )
    ).status,
    401,
  );
  const saved = await request("/admin/settings", "PUT", {
    ...values,
    introductionVideoUrl: url,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.introductionVideoUrl, url);
  assert.equal(
    (await app.locals.models.settings.findById("association").lean())
      .introductionVideoUrl,
    url,
  );
  await runtime.closeApp(app, server);
  app = server = undefined;
  await start();
  assert.equal(
    (await request("/public/settings", "GET", undefined, null)).body.data
      .introductionVideoUrl,
    url,
  );
  assert.equal(
    (await request("/admin/settings", "PUT", values)).body.data
      .introductionVideoUrl,
    url,
    "older forms must retain video",
  );
  for (const invalid of [
    "javascript:alert(1)",
    "data:video/mp4;base64,AAAA",
    "http://example.com/intro.mp4",
    "https://user:secret@example.com/video.mp4",
    "/video.mp4",
    "x".repeat(2049),
  ]) {
    assert.equal(
      (
        await request("/admin/settings", "PUT", {
          ...values,
          introductionVideoUrl: invalid,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/public/settings", "GET", undefined, null)).body.data
        .introductionVideoUrl,
      url,
    );
  }
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        ...values,
        introductionVideoUrl: "https://youtu.be/M7lc1UVf-VE",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        ...values,
        introductionVideoUrl: "",
      })
    ).body.data.introductionVideoUrl,
    "",
  );
  assert.equal(
    (await request("/public/settings", "GET", undefined, null)).body.data
      .introductionVideoUrl,
    "",
  );
});

test("video máy tính: tải theo phần, kiểm tra quyền, lưu DB và đọc Range sau khởi động lại", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 13, 7);
  bytes.write("ftyp", 4, "ascii");
  const root = "/admin/introduction-videos";
  assert.equal(
    (
      await request(
        root,
        "POST",
        { name: "intro.mp4", size: bytes.length },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request(root, "POST", { name: "intro.exe", size: 20 })).status,
    400,
  );
  const created = await request(root, "POST", {
    name: "intro.mp4",
    size: bytes.length,
  });
  assert.equal(created.status, 201);
  const { id, chunkSize, count } = created.body.data;
  const url = "/public/introduction-videos/" + id;
  const storedUrl = "/api/v1" + url;
  assert.equal((await fetch(base + url)).status, 404);
  assert.equal(
    (await request(root + "/" + id + "/complete", "POST", {})).status,
    409,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        ...values,
        introductionVideoUrl: storedUrl,
      })
    ).status,
    400,
  );
  async function part(index, data, auth = token) {
    return fetch(base + root + "/" + id + "/chunks/" + index, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(auth ? { Authorization: "Bearer " + auth } : {}),
      },
      body: data,
    });
  }
  assert.equal((await part(0, bytes.subarray(0, chunkSize), null)).status, 401);
  assert.equal((await part(0, Buffer.alloc(chunkSize))).status, 400);
  // Exercise simultaneous new chunks and duplicate retries against the unique index.
  const parallel = await Promise.all([
    part(1, bytes.subarray(chunkSize, 2 * chunkSize)),
    part(1, bytes.subarray(chunkSize, 2 * chunkSize)),
    part(2, bytes.subarray(2 * chunkSize)),
  ]);
  assert.deepEqual(
    parallel.map((response) => response.status),
    [200, 200, 200],
  );
  for (let index = 0; index < count; index++) {
    const data = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    assert.equal((await part(index, data)).status, 200);
    assert.equal((await part(index, data)).status, 200);
  }
  const conflicting = Buffer.from(bytes.subarray(0, chunkSize));
  conflicting[20] = 8;
  assert.equal((await part(0, conflicting)).status, 409);
  assert.equal(
    (await request(root + "/" + id + "/complete", "POST", {})).body.data.url,
    storedUrl,
  );
  assert.equal(
    (await request(root + "/" + id + "/complete", "POST", {})).status,
    200,
  );
  assert.equal((await part(0, bytes.subarray(0, chunkSize))).status, 200);
  assert.equal((await part(0, conflicting)).status, 409);
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        ...values,
        introductionVideoUrl: storedUrl,
      })
    ).status,
    200,
  );
  await runtime.closeApp(app, server);
  app = null;
  server = null;
  await start();
  assert.equal(
    (await request("/public/settings", "GET", undefined, null)).body.data
      .introductionVideoUrl,
    storedUrl,
  );
  const all = await fetch(base + url);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await all.arrayBuffer()), bytes);
  for (const [range, start, end] of [
    ["bytes=2097140-2097180", 2097140, 2097180],
    ["bytes=-13", bytes.length - 13, bytes.length - 1],
    ["bytes=0-", 0, chunkSize - 1],
  ]) {
    const res = await fetch(base + url, { headers: { Range: range } });
    assert.equal(res.status, 206);
    assert.equal(
      res.headers.get("content-range"),
      `bytes ${start}-${end}/${bytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      bytes.subarray(start, end + 1),
    );
  }
  assert.equal(
    (await fetch(base + url, { headers: { Range: "bytes=999999999-" } }))
      .status,
    416,
  );
  const head = await fetch(base + url, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const cancelled = (
    await request(root, "POST", { name: "cancel.webm", size: 16 })
  ).body.data.id;
  assert.equal((await request(root + "/" + cancelled, "DELETE")).status, 200);
  assert.equal(
    (await request(root + "/" + cancelled + "/complete", "POST", {})).status,
    404,
  );
  assert.equal(
    (
      await request("/admin/settings", "PUT", {
        ...values,
        introductionVideoUrl: "",
      })
    ).status,
    200,
  );
});
