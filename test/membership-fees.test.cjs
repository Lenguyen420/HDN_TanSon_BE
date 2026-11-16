const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const receiptHash = (value) => createHash("sha256").update(value).digest("hex");
const receipts = Object.fromEntries(
  ["a", "b", "pending", "rejected", "inactive", "deleted"].map((key) => [
    key,
    randomBytes(32).toString("hex"),
  ]),
);
const feeTokens = {};
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let mongo, app, server, runtime, base, admin;
async function request(path, method = "GET", body, token = admin) {
  token = feeTokens[token] || token;
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
const campaign = (extra = {}) => ({
  title: "Hội phí 2027",
  year: 2027,
  amount: 2000000,
  dueDate: "2027-12-31",
  target: "selected",
  targetMemberIds: ["member-a", "member-b"],
  paymentInstructions: "Ngân hàng kiểm thử, chỉ dùng trong test.",
  ...extra,
});
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri("membership_fee_isolated");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "fee_admin";
  process.env.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
  runtime = await import("../src/main.js");
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  await app.locals.models.members.create([
    {
      _id: "member-a",
      name: "Hội viên A",
      company: "A",
      joinedAt: "2026-01-01",
      zaloUserId: "111111",
    },
    {
      _id: "member-b",
      name: "Hội viên B",
      company: "B",
      joinedAt: "2026-01-01",
      zaloUserId: "222222",
    },
    {
      _id: "member-inactive",
      name: "Inactive",
      company: "C",
      joinedAt: "2026-01-01",
      status: "inactive",
    },
  ]);
  app.locals.services.memberAccess.transport = async () => {
    throw new Error("Fee authentication must not call Zalo Graph");
  };
  await app.locals.models.registrations.create([
    ...["a", "b"].map((suffix) => ({
      _id: "fee-registration-" + suffix,
      fullName: "Member " + suffix,
      company: "Company",
      phone: "0900000001",
      date: "2026-11-16",
      status: "approved",
      memberId: "member-" + suffix,
      notificationTokenHash: receiptHash(receipts[suffix]),
    })),
    {
      _id: "fee-registration-pending",
      fullName: "Pending",
      company: "Company",
      phone: "0900000002",
      date: "2026-11-16",
      status: "pending",
      notificationTokenHash: receiptHash(receipts.pending),
    },
    {
      _id: "fee-registration-rejected",
      fullName: "Rejected",
      company: "Company",
      phone: "0900000003",
      date: "2026-11-16",
      status: "rejected",
      notificationTokenHash: receiptHash(receipts.rejected),
    },
    {
      _id: "fee-registration-inactive",
      fullName: "Inactive",
      company: "Company",
      phone: "0900000004",
      date: "2026-11-16",
      status: "approved",
      memberId: "member-inactive",
      notificationTokenHash: receiptHash(receipts.inactive),
    },
    {
      _id: "fee-registration-deleted",
      fullName: "Deleted",
      company: "Company",
      phone: "0900000005",
      date: "2026-11-16",
      status: "approved",
      deletedAt: new Date(),
      notificationTokenHash: receiptHash(receipts.deleted),
    },
  ]);
  for (const suffix of ["a", "b"]) {
    const feeLogin = await request(
      "/membership-fees/session",
      "POST",
      { tokens: [receipts[suffix]] },
      null,
    );
    assert.equal(feeLogin.status, 200);
    feeTokens["member-" + suffix + "-token"] = feeLogin.body.data.accessToken;
  }

  const login = await request(
    "/auth/admin-login",
    "POST",
    {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
    null,
  );
  assert.equal(login.status, 200);
  admin = login.body.data.accessToken;
});
test.after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
});
test("membership fees: publication, ownership, proof, atomic decisions and audit", async (t) => {
  const root = "/admin/membership-fees";
  let id, a, b, paymentId;
  await t.test("authentication and strict input", async () => {
    assert.equal((await request(root, "GET", undefined, null)).status, 401);
    assert.equal(
      (await request(root, "GET", undefined, "member-a-token")).status,
      401,
    );
    assert.equal(
      (await request("/membership-fees/my-dues", "GET", undefined, null))
        .status,
      401,
    );
    assert.equal(
      (await request("/membership-fees/my-dues", "GET", undefined, "unlinked"))
        .status,
      401,
    );
    assert.equal(
      (await request(root, "POST", campaign({ amount: 1.5 }))).status,
      400,
    );
    assert.equal(
      (await request(root, "POST", campaign({ dueDate: "2027-02-30" }))).status,
      400,
    );
  });
  await t.test(
    "draft invisible, publish idempotent and assigns only once",
    async () => {
      const created = await request(root, "POST", campaign());
      assert.equal(created.status, 201);
      id = created.body.data.id;
      assert.equal(
        (
          await request(
            "/membership-fees/my-dues",
            "GET",
            undefined,
            "member-a-token",
          )
        ).body.pagination.total,
        0,
      );
      const published = await Promise.all([
        request(root + "/" + id + "/publish", "POST", {}),
        request(root + "/" + id + "/publish", "POST", {}),
      ]);
      assert.deepEqual(
        published.map((r) => r.status),
        [200, 200],
      );
      const result = await request(root + "/" + id + "/dues");
      assert.equal(result.body.summary.total, 2);
      a = result.body.data.find((d) => d.memberId === "member-a");
      b = result.body.data.find((d) => d.memberId === "member-b");
      const own = await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      );
      assert.equal(own.body.data.length, 1);
      assert.equal(own.body.data[0].id, a.id);
      assert.equal(own.body.data[0].campaign.targetMemberIds, undefined);
      assert.equal(own.body.data[0].campaign.audit, undefined);
      assert.equal(
        (
          await request(
            "/membership-fees/my-dues/" + b.id,
            "GET",
            undefined,
            "member-a-token",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "/membership-fees/my-dues/" + b.id + "/payment-proof",
            "POST",
            { transactionRef: "FORGED" },
            "member-a-token",
          )
        ).status,
        404,
      );
      assert.equal(
        (await request(root + "/" + id, "PATCH", { amount: 123 })).status,
        409,
      );
    },
  );
  await t.test(
    "proof remains pending, frontend cannot forge identity or amount",
    async () => {
      const path = "/membership-fees/my-dues/" + a.id + "/payment-proof";
      assert.equal(
        (
          await request(
            path,
            "POST",
            {
              transactionRef: "TX-1",
              amount: 1,
              memberId: "member-b",
              status: "paid",
            },
            "member-a-token",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            path,
            "POST",
            { transactionRef: "TX-1", proofUrl: "javascript:alert(1)" },
            "member-a-token",
          )
        ).status,
        400,
      );
      const result = await request(
        path,
        "POST",
        {
          transactionRef: "TX-1",
          proofUrl: "https://example.com/proof",
          note: "Đã chuyển",
        },
        "member-a-token",
      );
      assert.equal(result.status, 201);
      assert.equal(result.body.data.amount, 2000000);
      assert.equal(result.body.data.status, "pending");
      paymentId = result.body.data.id;
      assert.equal(
        (
          await request(
            "/membership-fees/my-dues/" + a.id,
            "GET",
            undefined,
            "member-a-token",
          )
        ).body.data.status,
        "pending_confirmation",
      );
      assert.equal(
        (
          await request(
            path,
            "POST",
            { transactionRef: "TX-2" },
            "member-a-token",
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "simultaneous confirm only records once, immutable paid amount",
    async () => {
      const path = "/admin/membership-fee-payments/" + paymentId + "/confirm";
      const results = await Promise.all([
        request(path, "POST", { note: "Đã đối soát" }),
        request(path, "POST", {}),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const own = await request(
        "/membership-fees/my-dues/" + a.id,
        "GET",
        undefined,
        "member-a-token",
      );
      assert.equal(own.body.data.status, "paid");
      assert.ok(own.body.data.paidAt);
      assert.ok(own.body.data.confirmedBy);
      assert.equal(
        own.body.data.payments[0].audit.filter((a) => a.action === "confirmed")
          .length,
        1,
      );
      assert.equal(own.body.data.campaign.targetMemberIds, undefined);
      assert.equal(
        (
          await request(root + "/" + id, "PATCH", {
            targetMemberIds: ["member-a"],
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    "duplicate transaction rolls back and rejected proof can be resubmitted",
    async () => {
      const path = "/membership-fees/my-dues/" + b.id + "/payment-proof";
      const pending = await request(
        path,
        "POST",
        { transactionRef: "tx-1" },
        "member-b-token",
      );
      assert.equal(pending.status, 201);
      const paymentRoot =
        "/admin/membership-fee-payments/" + pending.body.data.id;
      assert.equal(
        (await request(paymentRoot + "/confirm", "POST", {})).status,
        409,
      );
      assert.equal(
        (
          await request(
            "/membership-fees/my-dues/" + b.id,
            "GET",
            undefined,
            "member-b-token",
          )
        ).body.data.status,
        "pending_confirmation",
      );
      assert.equal(
        (
          await request(paymentRoot + "/reject", "POST", {
            note: "Mã giao dịch trùng, vui lòng kiểm tra.",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request(paymentRoot + "/confirm", "POST", {})).status,
        409,
      );
      const manual = "/admin/membership-fee-dues/" + b.id + "/manual-payment";
      assert.equal(
        (
          await request(manual, "POST", {
            transactionRef: "TX-1",
            method: "cash",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(manual, "POST", {
            transactionRef: "CASH-1",
            method: "cash",
            note: "Phiếu thu",
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request(manual, "POST", {
            transactionRef: "CASH-2",
            method: "cash",
          })
        ).status,
        409,
      );
      const list = await request(root);
      const summary = list.body.data.find((c) => c.id === id).summary;
      assert.equal(summary.paid, 2);
      assert.equal(summary.paidAmount, 4000000);
      assert.equal(summary.remainingAmount, 0);
    },
  );
});
test("all active, overdue, close cancels outstanding and preserves paid history", async () => {
  const root = "/admin/membership-fees";
  const created = await request(
    root,
    "POST",
    campaign({
      target: "all",
      targetMemberIds: [],
      status: "published",
      dueDate: "2020-01-01",
    }),
  );
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const result = await request(root + "/" + id + "/dues");
  assert.equal(result.body.summary.total, 2);
  assert.equal(result.body.summary.overdue, 2);
  const due = result.body.data.find((d) => d.memberId === "member-a");
  const proof = await request(
    "/membership-fees/my-dues/" + due.id + "/payment-proof",
    "POST",
    { transactionRef: "CLOSE-1" },
    "member-a-token",
  );
  assert.equal(proof.status, 201);
  assert.equal(
    (await request(root + "/" + id, "PATCH", { status: "closed" })).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/admin/membership-fee-payments/" + proof.body.data.id + "/confirm",
        "POST",
        {},
      )
    ).status,
    409,
  );
  const closed = await request(root + "/" + id + "/dues");
  assert.equal(closed.body.summary.cancelled, 2);
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues/" + due.id,
        "GET",
        undefined,
        "member-a-token",
      )
    ).body.data.status,
    "cancelled",
  );
  assert.equal(
    (await request(root + "/" + id + "/publish", "POST", {})).status,
    409,
  );
});
test("publication validates selected active members atomically", async () => {
  const before =
    await app.locals.models.membershipFees.campaigns.countDocuments();
  const result = await request(
    "/admin/membership-fees",
    "POST",
    campaign({
      status: "published",
      targetMemberIds: ["member-a", "member-inactive"],
    }),
  );
  assert.equal(result.status, 400);
  assert.equal(
    await app.locals.models.membershipFees.campaigns.countDocuments(),
    before,
  );
});
test("fee receipt sessions reject unapproved/invalid credentials and never call Zalo", async () => {
  const login = (tokens) =>
    request("/membership-fees/session", "POST", { tokens }, null);
  assert.equal((await login([randomBytes(32).toString("hex")])).status, 401);
  assert.equal((await login([receipts.deleted])).status, 401);
  for (const key of ["pending", "rejected", "inactive"])
    assert.equal((await login([receipts[key]])).status, 403);
  assert.equal((await login([])).status, 400);
  assert.equal((await login(["member-a"])).status, 400);
  assert.equal(
    (
      await request(
        "/membership-fees/session",
        "POST",
        {
          tokens: [receipts.pending],
          memberId: "member-a",
          status: "approved",
        },
        null,
      )
    ).status,
    400,
  );
  const result = await login([receipts.pending, receipts.rejected, receipts.a]);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.member.id, "member-a");
  const claims = JSON.parse(
    Buffer.from(
      result.body.data.accessToken.split(".")[1],
      "base64url",
    ).toString(),
  );
  assert.equal(claims.aud, "tanson-membership-fees");
  assert.equal(claims.receiptHash, receiptHash(receipts.a));
  assert.equal(claims.exp - claims.iat, 1800);
  assert.equal(
    (
      await request(
        "/trade-session",
        "GET",
        undefined,
        result.body.data.accessToken,
      )
    ).status,
    401,
  );
  const trade = await request(
    "/trade-session",
    "POST",
    { tokens: [receipts.a] },
    null,
  );
  assert.equal(trade.status, 200);
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        trade.body.data.accessToken,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request("/membership-fees/my-dues", "GET", undefined, admin)).status,
    401,
  );
});
test("fee sessions expire and are revoked when receipt or approval changes", async () => {
  const { createTokenService } = await import("../src/config/jwt.js");
  const expired = await createTokenService(process.env.JWT_SECRET).signAsync(
    { sub: "fee-registration-a", receiptHash: receiptHash(receipts.a) },
    {
      issuer: "tanson-backend",
      audience: "tanson-membership-fees",
      expiresIn: -1,
    },
  );
  assert.equal(
    (await request("/membership-fees/my-dues", "GET", undefined, expired))
      .status,
    401,
  );
  const model = app.locals.models.registrations;
  await model.updateOne(
    { _id: "fee-registration-a" },
    { $set: { notificationTokenHash: receiptHash("rotated") } },
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    401,
  );
  await model.updateOne(
    { _id: "fee-registration-a" },
    {
      $set: {
        notificationTokenHash: receiptHash(receipts.a),
        status: "rejected",
      },
    },
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    403,
  );
  await model.updateOne(
    { _id: "fee-registration-a" },
    { $set: { status: "approved", deletedAt: new Date() } },
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    401,
  );
  await model.updateOne(
    { _id: "fee-registration-a" },
    { $set: { deletedAt: null } },
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    200,
  );
});

test("image proofs need no transaction code, stay private and produce stable fee notifications", async () => {
  const { png } = require("./image-fixture.cjs");
  const bytes = png(400, 400),
    image = "data:image/png;base64," + bytes.toString("base64");
  const title = "Hội phí có ảnh minh chứng";
  const created = await request(
    "/admin/membership-fees",
    "POST",
    campaign({ title }),
  );
  assert.equal(created.status, 201);
  const campaignId = created.body.data.id;
  const updates = (token) =>
    request(
      "/public/registration-notifications",
      "POST",
      { tokens: [token] },
      null,
    );
  const before = await updates(receipts.a);
  assert.equal(
    before.body.data.some((n) => n.title.includes(title)),
    false,
  );
  await request(
    "/admin/membership-fees/" + campaignId + "/publish",
    "POST",
    {},
  );
  await request(
    "/admin/membership-fees/" + campaignId + "/publish",
    "POST",
    {},
  );
  const list = await request("/admin/membership-fees/" + campaignId + "/dues");
  const a = list.body.data.find((d) => d.memberId === "member-a"),
    b = list.body.data.find((d) => d.memberId === "member-b");
  const notifications = (await updates(receipts.a)).body.data.filter(
    (n) => n.feeDueId === a.id,
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].scope, "private");
  assert.equal(
    (await updates(receipts.b)).body.data.some((n) => n.feeDueId === a.id),
    false,
  );
  const submit = (id, token, body) =>
    request(
      "/membership-fees/my-dues/" + id + "/payment-proof",
      "POST",
      body,
      token,
    );
  const files = () =>
    app.locals.db.db.collection("membership_fee_proofs.files").countDocuments();
  assert.equal(
    (
      await submit(a.id, "member-a-token", {
        proofImage:
          "data:image/png;base64," +
          Buffer.from("invalid image bytes").toString("base64"),
      })
    ).status,
    400,
  );
  assert.equal(
    (await submit(a.id, "member-a-token", { note: "Không có ảnh" })).status,
    400,
  );
  const sent = await submit(a.id, "member-a-token", {
    proofImage: image,
    note: "Đã chuyển khoản",
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.status, "pending");
  assert.equal(sent.body.data.proofFileId, undefined);
  assert.equal(sent.body.data.proofHash, undefined);
  assert.ok(sent.body.data.transactionRef.startsWith("HP-"));
  const paymentId = sent.body.data.id;
  const count = await files();
  assert.equal(
    (await submit(a.id, "member-a-token", { proofImage: image })).status,
    409,
  );
  assert.equal(await files(), count);
  const path = "/membership-fees/payments/" + paymentId + "/proof";
  assert.equal((await request(path, "GET", undefined, null)).status, 401);
  assert.equal(
    (await request(path, "GET", undefined, "member-b-token")).status,
    404,
  );
  const raw = await fetch(base + path, {
    headers: { Authorization: "Bearer " + feeTokens["member-a-token"] },
  });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.match(raw.headers.get("cache-control"), /no-store/);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
  const json = await request(
    path + "?format=data",
    "GET",
    undefined,
    "member-a-token",
  );
  assert.equal(json.body.data.image, image);
  const adminImage = await fetch(
    base + "/admin/membership-fee-payments/" + paymentId + "/proof",
    { headers: { Authorization: "Bearer " + admin } },
  );
  assert.equal(adminImage.status, 200);
  await adminImage.arrayBuffer();
  assert.equal(
    (
      await request(
        "/admin/membership-fee-inbox",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    401,
  );
  const inbox = (await request("/admin/membership-fee-inbox")).body;
  assert.equal(inbox.data.filter((n) => n.paymentId === paymentId).length, 1);
  assert.equal(
    inbox.data.find((n) => n.paymentId === paymentId).status,
    "pending",
  );
  assert.match(
    inbox.data.find((n) => n.paymentId === paymentId).href,
    /campaignId=/,
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues/" + a.id,
        "GET",
        undefined,
        "member-a-token",
      )
    ).body.data.status,
    "pending_confirmation",
  );
  assert.equal(
    (
      await request(
        "/admin/membership-fee-payments/" + paymentId + "/confirm",
        "POST",
        {},
      )
    ).status,
    200,
  );
  const duplicate = await submit(b.id, "member-b-token", { proofImage: image });
  assert.equal(duplicate.status, 201);
  assert.equal(
    (
      await request(
        "/admin/membership-fee-payments/" + duplicate.body.data.id + "/confirm",
        "POST",
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues/" + b.id,
        "GET",
        undefined,
        "member-b-token",
      )
    ).body.data.status,
    "pending_confirmation",
  );
  assert.equal(
    (await request("/admin/membership-fee-inbox")).body.data.find(
      (n) => n.paymentId === paymentId,
    ).status,
    "approved",
  );
});

test("admin manual collection accepts a local proof without a transaction code", async () => {
  const { png } = require("./image-fixture.cjs");
  const created = await request(
    "/admin/membership-fees",
    "POST",
    campaign({ status: "published", targetMemberIds: ["member-a"] }),
  );
  const dues = await request(
    "/admin/membership-fees/" + created.body.data.id + "/dues",
  );
  const due = dues.body.data[0],
    bytes = png(401, 400);
  const result = await request(
    "/admin/membership-fee-dues/" + due.id + "/manual-payment",
    "POST",
    {
      method: "bank_transfer",
      proofImage: "data:image/png;base64," + bytes.toString("base64"),
      note: "Thu thủ công",
    },
  );
  assert.equal(result.status, 201);
  assert.equal(result.body.data.status, "confirmed");
  assert.ok(result.body.data.transactionRef.startsWith("HP-"));
  assert.equal(result.body.data.proofFileId, undefined);
  const detail = await request(
    "/membership-fees/my-dues/" + due.id,
    "GET",
    undefined,
    "member-a-token",
  );
  assert.equal(detail.body.data.status, "paid");
  const image = await fetch(
    base + "/admin/membership-fee-payments/" + result.body.data.id + "/proof",
    { headers: { Authorization: "Bearer " + admin } },
  );
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
});

test("members receive private confirmation/rejection results with reasons and stable links", async () => {
  const fees = app.locals.services.membershipFees,
    reviewer = "reviewer-test";
  const notices = async (receipt) =>
    (
      await request(
        "/public/registration-notifications",
        "POST",
        { tokens: [receipt] },
        null,
      )
    ).body.data;
  const created = await fees.create(
    campaign({ status: "published", title: "Thông báo kết quả đối soát" }),
    reviewer,
  );
  const rows = await fees.listDues(created.data.id, { page: 1, limit: 100 });
  const a = rows.data.find((d) => d.memberId === "member-a"),
    b = rows.data.find((d) => d.memberId === "member-b");
  const first = await fees.submit(a.id, "member-a", {
    transactionRef: "RESULT-A1",
    note: "Đã chuyển",
  });
  assert.equal(
    (await notices(receipts.a)).some((n) =>
      n.id.startsWith("fee-reviewed-" + first.data.id),
    ),
    false,
  );
  const noReason = await request(
    "/admin/membership-fee-payments/" + first.data.id + "/reject",
    "POST",
    { note: "   " },
  );
  assert.equal(noReason.status, 400);
  const reason = "Ảnh bị mờ, chưa thấy số tiền. Vui lòng gửi lại ảnh rõ hơn.";
  await fees.decide(first.data.id, false, { note: reason }, reviewer);
  let own = await notices(receipts.a);
  const rejected = own.filter(
    (n) => n.id === "fee-reviewed-" + first.data.id + "-rejected",
  );
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].feeDueId, a.id);
  assert.equal(rejected[0].scope, "private");
  assert.ok(rejected[0].description.includes(reason));
  assert.ok(rejected[0].paragraphs.some((p) => p.includes(reason)));
  assert.equal(
    (await notices(receipts.b)).some(
      (n) => n.id === rejected[0].id || n.description.includes(reason),
    ),
    false,
  );
  const retry = await fees.submit(a.id, "member-a", {
    transactionRef: "RESULT-A2",
    note: "Ảnh đã kiểm tra",
  });
  const confirmed = await fees.decide(
    retry.data.id,
    true,
    { note: "Đã đối soát" },
    reviewer,
  );
  own = await notices(receipts.a);
  const paid = own.find(
    (n) => n.id === "fee-reviewed-" + retry.data.id + "-confirmed",
  );
  assert.ok(paid);
  assert.equal(paid.feeDueId, a.id);
  assert.match(paid.description, /2\.000\.000/);
  assert.ok(paid.description.includes(created.data.title));
  assert.equal(
    paid.createdAt,
    new Date(confirmed.data.confirmedAt).toISOString(),
  );
  assert.ok(own.some((n) => n.id === rejected[0].id));
  await assert.rejects(
    fees.decide(retry.data.id, true, { note: "" }, reviewer),
    (e) => e.status === 409,
  );
  assert.equal(
    (await notices(receipts.a)).filter((n) => n.id === paid.id).length,
    1,
  );
  const manual = await fees.manual(
    b.id,
    { method: "cash", note: "Đã nhận tiền mặt" },
    reviewer,
  );
  assert.equal(
    (await notices(receipts.b)).filter(
      (n) => n.id === "fee-reviewed-" + manual.data.id + "-confirmed",
    ).length,
    1,
  );
  assert.equal(
    (await notices(receipts.a)).some(
      (n) => n.id === "fee-reviewed-" + manual.data.id + "-confirmed",
    ),
    false,
  );
  const other = await fees.create(
    campaign({
      status: "published",
      title: "Không thông báo khi xác nhận lỗi",
      targetMemberIds: ["member-a"],
    }),
    reviewer,
  );
  const due = (await fees.listDues(other.data.id, { page: 1, limit: 100 }))
    .data[0];
  const failed = await fees.submit(due.id, "member-a", {
    transactionRef: "RESULT-A2",
    note: "Trùng",
  });
  await assert.rejects(
    fees.decide(failed.data.id, true, { note: "" }, reviewer),
    (e) => e.code === 11000,
  );
  assert.equal(
    (await notices(receipts.a)).some((n) =>
      n.id.startsWith("fee-reviewed-" + failed.data.id),
    ),
    false,
  );
  await fees.update(other.data.id, { status: "closed" }, reviewer);
  assert.equal(
    (await notices(receipts.a)).some((n) =>
      n.id.startsWith("fee-reviewed-" + failed.data.id),
    ),
    false,
  );
});

test("membership revocation immediately removes fee access", async () => {
  await app.locals.models.members.updateOne(
    { _id: "member-a" },
    { $set: { status: "inactive" } },
  );
  assert.equal(
    (
      await request(
        "/membership-fees/my-dues",
        "GET",
        undefined,
        "member-a-token",
      )
    ).status,
    403,
  );
});
