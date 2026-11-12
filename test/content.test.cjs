const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { mkdtemp, rm, readFile, readdir } = require("node:fs/promises");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { png } = require("./image-fixture.cjs");
let uploadDirectory;
let mongo, app, server, closeApp, base, token;
const password = randomBytes(24).toString("base64url");
async function request(path, method = "GET", body, auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const article = {
  title: "Kết nối doanh nghiệp [Tân Sơn]",
  topic: "Hoạt động Hội",
  publishedAt: "2020-01-01",
  status: "draft",
  summary: "Gặp gỡ và chia sẻ",
  paragraphs: ["Đoạn thứ nhất", "Đoạn thứ hai"],
  image: "",
  author: "Ban biên tập",
};
const fixtures = {
  news: article,
  events: {
    ...article,
    event: {
      date: "2026-11-20",
      time: "08:00 - 11:00",
      venue: "Hội trường",
      address: "Tân Sơn",
      agenda: [{ time: "08:00", title: "Đón tiếp" }],
    },
  },
  "member-visits": {
    ...article,
    visit: {
      company: "Doanh nghiệp mẫu",
      representative: "Nguyễn Văn A",
      date: "2026-11-10",
      address: "Tân Sơn",
      field: "Thương mại",
    },
  },
  notifications: {
    title: "Thông báo Hội",
    category: "Chung",
    date: "2020-01-01",
    time: "08:00",
    status: "draft",
    description: "Thông tin mới",
    paragraphs: ["Nội dung thông báo"],
  },
  banners: {
    image: "/association/banner.webp",
    alt: "Kết nối cộng đồng",
    order: 2,
    status: "inactive",
  },
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("tanson_content_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "content_admin";
  process.env.ADMIN_PASSWORD = password;
  process.env.ADMIN_NAME = "Quản trị nội dung kiểm thử";
  const runtime = await import("../src/main.js");
  closeApp = runtime.closeApp;
  uploadDirectory = await mkdtemp(join(tmpdir(), "tanson-uploads-"));
  app = await runtime.createApp({ uploadDirectory });
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  const login = await request(
    "/auth/admin-login",
    "POST",
    { username: "content_admin", password },
    null,
  );
  assert.equal(login.status, 200);
  token = login.body.data.accessToken;
});
test.after(async () => {
  if (app) await closeApp(app, server);
  if (mongo) await mongo.stop();
  if (uploadDirectory) {
    assert.ok(
      resolve(uploadDirectory).startsWith(
        resolve(tmpdir()) + sep + "tanson-uploads-",
      ),
    );
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});

test("CRUD và xuất bản đủ năm nhóm nội dung, lưu riêng các collection", async (t) => {
  for (const [collection, dto] of Object.entries(fixtures)) {
    await t.test(collection, async () => {
      const admin = "/admin/" + collection,
        pub = "/public/" + collection;
      assert.equal((await request(admin, "GET", undefined, null)).status, 401);
      assert.equal((await request(admin, "POST", dto, null)).status, 401);
      const created = await request(admin, "POST", dto);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.id;
      assert.ok(id);
      assert.equal(created.body.data._id, undefined);
      assert.equal(created.body.data.deletedAt, undefined);
      assert.equal(
        (await app.locals.models.content[collection].findById(id).lean())
          .status,
        dto.status,
      );
      assert.equal(
        (await request(pub + "/" + id, "GET", undefined, null)).status,
        404,
      );
      assert.equal(
        (await request(pub, "GET", undefined, null)).body.pagination.total,
        0,
      );
      const changed = {
        ...dto,
        status: collection === "banners" ? "active" : "published",
      };
      assert.equal(
        (await request(admin + "/" + id, "PUT", changed)).status,
        200,
      );
      assert.equal(
        (await request(pub + "/" + id, "GET", undefined, null)).status,
        200,
      );
      const list = await request(
        pub + "?page=1&limit=1",
        "GET",
        undefined,
        null,
      );
      assert.equal(list.body.data[0].id, id);
      assert.deepEqual(list.body.pagination, { page: 1, limit: 1, total: 1 });
      assert.equal(
        (await request(pub + "?status=draft", "GET", undefined, null)).status,
        400,
      );
      assert.equal(
        (
          await request(admin + "/" + id, "PUT", {
            ...changed,
            id: "different-id",
          })
        ).status,
        400,
      );
      assert.equal((await request(admin + "/" + id, "DELETE")).status, 200);
      assert.ok(
        (await app.locals.models.content[collection].findById(id).lean())
          .deletedAt,
      );
      assert.equal((await request(admin + "/" + id)).status, 404);
      assert.equal(
        (await request(pub + "/" + id, "GET", undefined, null)).status,
        404,
      );
      assert.equal((await request(admin)).body.pagination.total, 0);
      assert.equal(
        (await request(admin + "/" + id, "PUT", changed)).status,
        404,
      );
    });
  }
});

test("lọc, phân trang, tìm ký tự regex và không công bố trước ngày", async () => {
  for (const [id, topic, status, publishedAt] of [
    ["news-one", "Kết nối", "published", "2020-01-01"],
    ["news-two", "Chính sách", "draft", "2020-01-02"],
    ["news-future", "Kết nối", "published", "2999-01-01"],
  ]) {
    assert.equal(
      (
        await request("/admin/news", "POST", {
          ...article,
          id,
          topic,
          status,
          publishedAt,
        })
      ).status,
      201,
    );
  }
  const filtered = await request(
    "/admin/news?topic=" +
      encodeURIComponent("Kết nối") +
      "&status=published&limit=1&page=2",
  );
  assert.equal(filtered.body.pagination.total, 2);
  assert.equal(filtered.body.data[0].id, "news-one");
  assert.equal(
    (await request("/admin/news?search=%5BT%C3%A2n%20S%C6%A1n%5D")).body
      .pagination.total,
    3,
  );
  assert.equal(
    (await request("/admin/news?search=%5B.*%5D")).body.pagination.total,
    0,
  );
  const pub = await request("/public/news", "GET", undefined, null);
  assert.deepEqual(
    pub.body.data.map((row) => row.id),
    ["news-one"],
  );
  assert.equal(
    (await request("/public/news/news-future", "GET", undefined, null)).status,
    404,
  );
  assert.equal(
    (await request("/public/news/news-two", "GET", undefined, null)).status,
    404,
  );
  assert.equal(
    (await request("/admin/news", "POST", { ...article, id: "news-one" }))
      .status,
    409,
  );
});

test("banner sắp theo thứ tự, bỏ banner ẩn; thông báo tương lai không lộ", async () => {
  for (const [id, order, status] of [
    ["banner-three", 3, "active"],
    ["banner-one", 1, "active"],
    ["banner-hidden", 2, "inactive"],
  ])
    assert.equal(
      (
        await request("/admin/banners", "POST", {
          ...fixtures.banners,
          id,
          order,
          status,
        })
      ).status,
      201,
    );
  const banners = await request("/public/banners", "GET", undefined, null);
  assert.deepEqual(
    banners.body.data.map((row) => row.id),
    ["banner-one", "banner-three"],
  );
  assert.equal(
    (
      await request("/admin/notifications", "POST", {
        ...fixtures.notifications,
        id: "notice-future",
        date: "2999-01-01",
        status: "published",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/public/notifications/notice-future",
        "GET",
        undefined,
        null,
      )
    ).status,
    404,
  );
});

test("từ chối ngày sai, trạng thái sai, object injection, trường lạ và ảnh không an toàn", async () => {
  const invalid = [
    ["news", { ...article, publishedAt: "2026-02-30" }],
    ["news", { ...article, paragraphs: [] }],
    ["news", { ...article, title: "  " }],
    ["news", { ...article, status: "active" }],
    ["news", { ...article, deletedAt: null }],
    ["news", { ...article, image: "javascript:alert(1)" }],
    ["news", { ...article, image: "data:image/svg+xml;base64,PHN2Zz4=" }],
    ["news", { ...article, image: "//untrusted.example/image.jpg" }],
    [
      "events",
      {
        ...fixtures.events,
        event: { ...fixtures.events.event, date: "2026-02-30" },
      },
    ],
    [
      "events",
      {
        ...fixtures.events,
        event: {
          ...fixtures.events.event,
          agenda: [{ time: "08:00", title: "" }],
        },
      },
    ],
    [
      "member-visits",
      {
        ...fixtures["member-visits"],
        visit: { ...fixtures["member-visits"].visit, extra: true },
      },
    ],
    ["notifications", { ...fixtures.notifications, time: "25:00" }],
    ["banners", { ...fixtures.banners, image: "" }],
    ["banners", { ...fixtures.banners, order: 1.5 }],
  ];
  for (const [collection, dto] of invalid)
    assert.equal(
      (await request("/admin/" + collection, "POST", dto)).status,
      400,
      collection,
    );
  for (const query of [
    "limit=101",
    "page=0",
    "status%5B%24ne%5D=draft",
    "unknown=true",
  ])
    assert.equal((await request("/admin/news?" + query)).status, 400);
  assert.equal((await request("/admin/news/bad%20id")).status, 400);
  assert.equal(
    (await request("/public/news", "POST", article, null)).status,
    404,
  );
});

test("ảnh base64 của ImagePicker lớn hơn 256 KB lưu được, giới hạn 2 MB vẫn áp dụng", async () => {
  const bytes = png(350, 350);
  const image = "data:image/png;base64," + bytes.toString("base64");
  const created = await request("/admin/banners", "POST", {
    ...fixtures.banners,
    image,
  });
  assert.equal(created.status, 201);
  const stored = (await request("/admin/banners/" + created.body.data.id)).body
    .data.image;
  assert.match(stored, /^uploads\/banners\/[a-f0-9-]{36}\.png$/);
  assert.deepEqual(
    await readFile(join(uploadDirectory, ...stored.split("/").slice(1))),
    bytes,
  );
  const asset = await fetch(new URL("/" + stored, base));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(
    asset.headers.get("cross-origin-resource-policy"),
    "cross-origin",
  );
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
  const db = await app.locals.models.content.banners
    .findById(created.body.data.id)
    .lean();
  assert.equal(db.image, stored);
  assert.equal(
    (
      await request("/admin/banners", "POST", {
        ...fixtures.banners,
        image: "data:image/webp;base64," + "A".repeat(1_400_000),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/admin/banners", "POST", {
        ...fixtures.banners,
        image: "A".repeat(2_100_000),
      })
    ).status,
    413,
  );
});

test("ảnh được chia đúng thư mục, sửa giữ đường dẫn, lỗi ghi DB không để lại file rác", async () => {
  const { contentDefinitions } = await import("../src/dto/content.dto.js");
  const image = "data:image/png;base64," + png().toString("base64");
  for (const collection of ["news", "events", "member-visits", "banners"]) {
    const service = app.locals.services.content[collection];
    const dto = {
      ...fixtures[collection],
      id: "upload-test-" + collection,
      image,
    };
    const created = await service.create(dto);
    const stored = created.data.image;
    assert.ok(stored.startsWith("uploads/" + collection + "/"));
    const update = await service.update(
      dto.id,
      contentDefinitions[collection].body.parse({ ...dto, image: stored }),
    );
    assert.equal(update.data.image, stored);
    const before = await readdir(join(uploadDirectory, collection));
    await assert.rejects(service.create(dto), (error) => error.code === 11000);
    assert.deepEqual(await readdir(join(uploadDirectory, collection)), before);
    const replaced = await service.update(dto.id, dto);
    assert.notEqual(replaced.data.image, stored);
    // Keep previous files: other records or soft-deleted records may reference them.
    assert.ok(
      (await readFile(join(uploadDirectory, ...stored.split("/").slice(1))))
        .length,
    );
  }
  for (const image of [
    "uploads/news/../../secret.png",
    "uploads/news/missing.png",
    "data:image/png;base64," + Buffer.from("not an image").toString("base64"),
  ]) {
    await assert.rejects(
      async () =>
        app.locals.services.content.news.create(
          contentDefinitions.news.body.parse({ ...article, image }),
        ),
      (error) => error.status === 400 || error.name === "ZodError",
    );
  }
  assert.equal(
    (await fetch(new URL("/uploads/news/does-not-exist.png", base))).status,
    404,
  );
});

test("lịch công bố dùng ngày và giờ Việt Nam cho cả danh sách và chi tiết", async () => {
  const service = app.locals.services.content.notifications;
  for (const [id, date, time] of [
    ["clock-past", "2026-11-10", "23:59"],
    ["clock-ready", "2026-11-11", "08:30"],
    ["clock-later", "2026-11-11", "08:31"],
    ["clock-tomorrow", "2026-11-12", "00:00"],
  ]) {
    await service.create({
      ...fixtures.notifications,
      id,
      category: "Clock test",
      status: "published",
      date,
      time,
    });
  }
  const NativeDate = global.Date;
  // 08:30 tại Việt Nam, không phụ thuộc ngày/giờ máy chạy test.
  global.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : ["2026-11-11T01:30:00Z"]));
    }
  };
  try {
    const list = await service.list(
      { page: 1, limit: 20, category: "Clock test", search: "Thông báo" },
      true,
    );
    assert.deepEqual(
      list.data.map((row) => row.id),
      ["clock-ready", "clock-past"],
    );
    assert.equal(list.pagination.total, 2);
    assert.equal((await service.get("clock-ready", true)).id, "clock-ready");
    for (const id of ["clock-later", "clock-tomorrow"])
      await assert.rejects(
        service.get(id, true),
        (error) => error.status === 404,
      );
    assert.equal((await service.get("clock-later")).id, "clock-later");
  } finally {
    global.Date = NativeDate;
  }
});

test("metadata update keeps a missing legacy image; replacements are validated", async () => {
  const created = await request("/admin/banners", "POST", {
    ...fixtures.banners,
    image: "data:image/png;base64," + png().toString("base64"),
  });
  assert.equal(created.status, 201);
  const record = created.body.data;
  await rm(join(uploadDirectory, ...record.image.split("/").slice(1)));
  const dto = {
    image: record.image,
    alt: "Updated banner description",
    order: 7,
    status: "inactive",
  };
  const updated = await request("/admin/banners/" + record.id, "PUT", dto);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.image, record.image);
  assert.equal(updated.body.data.alt, dto.alt);
  assert.equal(updated.body.data.order, 7);
  const changed = await request("/admin/banners/" + record.id, "PUT", {
    ...dto,
    image: "uploads/banners/00000000-0000-4000-8000-000000000000.png",
  });
  assert.equal(changed.status, 400);
  const replaced = await request("/admin/banners/" + record.id, "PUT", {
    ...dto,
    image: "data:image/png;base64," + png().toString("base64"),
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.notEqual(replaced.body.data.image, record.image);
});
