const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { inflateRawSync } = require("node:zlib");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let mongo, app, server, runtime, base, admin, staff, today, temp;
const prefix = "/admin/finance";
const day = (offset) =>
  new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
const proof = {
  name: "chứng từ.pdf",
  base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
};
const entry = (businessDate, type, amount, content, extra = {}) => ({
  businessDate,
  type,
  amount,
  content,
  category: "ACTIVITY",
  paymentMethod: "BANK_TRANSFER",
  ...extra,
});

async function http(path, method = "GET", body, token = admin, key) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: data, headers: response.headers };
}
const request = (path, ...args) => http(prefix + path, ...args);
const add = (input, key = randomUUID(), token = admin) =>
  request("/transactions", "POST", input, token, key);
const close = (date, token = admin) =>
  request("/daily/" + date + "/close", "POST", {}, token);
const reverse = (id, date, token = admin, key = randomUUID()) =>
  request(
    "/transactions/" + id + "/reverse",
    "POST",
    { businessDate: date, reason: "Đã hoàn tiền" },
    token,
    key,
  );
const range = (from, to) => "?from=" + from + "&to=" + to;

test.before(async () => {
  const { financeToday } = await import("../src/services/financeShared.js");
  today = financeToday();
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri("finance_isolated");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "finance_admin";
  process.env.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
  temp = await require("node:fs/promises").mkdtemp(
    require("node:path").join(require("node:os").tmpdir(), "finance-test-"),
  );
  runtime = await import("../src/main.js");
  app = await runtime.createApp({ uploadDirectory: temp });
  server = await runtime.listen(app, 0);
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  const password = randomBytes(24).toString("base64url");
  const { hashPassword } = await import("../src/utils/password.js");
  await app.locals.models.admins.create({
    _id: "finance-staff",
    name: "Finance Staff",
    username: "finance_staff",
    passwordHash: await hashPassword(password),
    role: "STAFF",
  });
  admin = await login(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
  staff = await login("finance_staff", password);
});

test.after(async () => {
  if (app) await runtime.closeApp(app, server);
  if (mongo) await mongo.stop();
  if (temp)
    await require("node:fs/promises").rm(temp, {
      recursive: true,
      force: true,
    });
});

async function login(username, password) {
  const response = await http(
    "/auth/admin-login",
    "POST",
    { username, password },
    null,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.accessToken;
}

async function newCampaign() {
  const memberIds = [
    "finance-member-a",
    "finance-member-b",
    "finance-member-c",
  ];
  await app.locals.models.members.create(
    memberIds.map((_id) => ({
      _id,
      name: _id,
      company: "Hội viên test",
      joinedAt: day(-2),
    })),
  );
  const campaign = await http("/admin/membership-fees", "POST", {
    title: "Hội phí thử nghiệm",
    year: Number(today.slice(0, 4)),
    amount: 1000,
    dueDate: today,
    target: "selected",
    targetMemberIds: memberIds,
    status: "published",
  });
  assert.equal(campaign.status, 201, JSON.stringify(campaign.body));
  const dues = await app.locals.models.membershipFees.dues
    .find({ campaignId: campaign.body.data.id })
    .sort({ memberId: 1 })
    .lean();
  assert.equal(dues.length, memberIds.length);
  return { campaign: campaign.body.data, dues };
}

function pay(id, transactionRef) {
  return http("/admin/membership-fee-dues/" + id + "/manual-payment", "POST", {
    method: "cash",
    transactionRef,
  });
}

async function contribution(partnerId, type, title, more) {
  const result = await http(
    "/admin/partners/" + partnerId + "/contributions",
    "POST",
    {
      requestId: randomUUID(),
      title,
      type,
      contributionDate: day(-2),
      description: "Dữ liệu thử nghiệm",
      isPublished: true,
      ...more,
    },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data.id;
}

function workbookParts(bytes) {
  const parts = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString("utf8", offset + 30, offset + 30 + nameSize);
    const start = offset + 30 + nameSize + extraSize;
    parts[name] = inflateRawSync(bytes.subarray(start, start + size)).toString(
      "utf8",
    );
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return parts;
}

test("finance ledger preserves balances, access control and atomic source history", async (t) => {
  let dues, manual;
  const first = day(-5),
    empty = day(-4),
    second = day(-3),
    third = day(-2);
  await t.test(
    "authentication, pre-opening legacy fee and one-time settings",
    async () => {
      assert.equal(
        (await request("/settings", "GET", undefined, null)).status,
        401,
      );
      assert.deepEqual(
        (await request("/settings", "GET", undefined, staff)).body.data,
        {
          initialized: false,
          openingDate: null,
          openingBalance: null,
          closedThrough: null,
          openingProposal: {
            openingDate: today,
            openingBalance: 0,
            feePaymentCount: 0,
          },
        },
      );
      assert.equal(
        (await request("/summary")).body.code,
        "FINANCE_NOT_INITIALIZED",
      );
      ({ dues } = await newCampaign());
      await app.locals.models.membershipFees.payments.create([
        { _id: "fee-opening-pending", status: "pending", amount: 900000 },
        { _id: "fee-opening-rejected", status: "rejected", amount: 800000 },
        {
          _id: "fee-opening-refunded",
          status: "confirmed",
          financeRefundId: "old-refund",
          amount: 700000,
        },
      ]);
      await app.locals.models.membershipFees.dues.updateOne(
        { _id: dues[0]._id },
        { $set: { amountDue: 20000000 } },
      );
      t.mock.timers.enable({
        apis: ["Date"],
        now: new Date(first + "T05:00:00.000Z"),
      });
      try {
        const initial = {
          expectedOpeningDate: first,
          expectedOpeningBalance: 0,
        };
        const legacy = await pay(dues[0]._id, "FEE-LEGACY");
        assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
        assert.equal(
          await app.locals.models.finance.entries.countDocuments(),
          0,
        );
        const stale = await request("/settings/opening", "POST", initial);
        assert.equal(stale.body.code, "FINANCE_OPENING_CHANGED");
        assert.equal(
          (
            await request("/settings/opening", "POST", {
              openingDate: first,
              openingBalance: 999,
            })
          ).status,
          400,
        );
        const proposal = (await request("/settings")).body.data.openingProposal;
        assert.deepEqual(proposal, {
          openingDate: first,
          openingBalance: 20000000,
          feePaymentCount: 1,
        });
        const body = {
          expectedOpeningDate: first,
          expectedOpeningBalance: proposal.openingBalance,
        };
        assert.equal(
          (await request("/settings/opening", "POST", body, staff)).status,
          403,
        );
        const race = await Promise.all([
          request("/settings/opening", "POST", body),
          request("/settings/opening", "POST", body),
        ]);
        assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
        assert.equal(
          race.find((r) => r.status === 201).body.data.openingBalance,
          20000000,
        );
        assert.equal(
          await app.locals.models.finance.entries.countDocuments(),
          0,
        );
      } finally {
        t.mock.timers.reset();
      }
      assert.equal(
        (await add(entry(day(-6), "INCOME", 1, "Too early"))).body.code,
        "FINANCE_DATE_OUT_OF_RANGE",
      );
      assert.equal(
        (await add(entry(day(1), "INCOME", 1, "Too late"))).status,
        422,
      );
      assert.equal(
        (await add(entry(first, "INCOME", 1.5, "Non-integer"))).status,
        400,
      );
      assert.equal(
        (
          await request(
            "/transactions",
            "POST",
            entry(first, "INCOME", 1, "Missing key"),
          )
        ).body.code,
        "FINANCE_INVALID_IDEMPOTENCY_KEY",
      );
    },
  );

  await t.test(
    "idempotent transactions, literal filters, XLSX and private documents",
    async () => {
      const body = entry(first, "INCOME", 2000000, "=SUM(1+2) hội phí", {
        attachments: [proof],
      });
      const key = randomUUID();
      const replay = await Promise.all([
        add(body, key, staff),
        add(body, key, staff),
      ]);
      assert.deepEqual(
        replay.map((r) => r.status),
        [201, 201],
        JSON.stringify(replay.map((r) => r.body)),
      );
      assert.deepEqual(replay[0].body, replay[1].body);
      assert.equal(
        (await add({ ...body, amount: 3000000 }, key, staff)).body.code,
        "FINANCE_IDEMPOTENCY_CONFLICT",
      );
      const pdf = replay[0].body.data.attachments[0];
      assert.equal(
        (await http(pdf.url.replace("/api/v1", ""), "GET", undefined, null))
          .status,
        401,
      );
      const file = await http(
        pdf.url.replace("/api/v1", ""),
        "GET",
        undefined,
        staff,
      );
      assert.equal(file.status, 200);
      assert.equal(
        file.body.toString(),
        Buffer.from(proof.base64, "base64").toString(),
      );
      assert.match(file.headers.get("cache-control"), /no-store/);
      const expense = await add(
        entry(first, "EXPENSE", 500000, "Chi mua hoa tặng đơn vị", {
          counterparty: "Đơn vị A",
        }),
      );
      assert.equal(expense.status, 201);
      const firstDay = (await request("/daily/" + first)).body.data;
      assert.equal(firstDay.closingBalance, 21500000);
      assert.equal(
        firstDay.transactions.find((row) => row.id === expense.body.data.id)
          .counterparty,
        "Đơn vị A",
      );
      const following = (await request("/daily/" + empty)).body.data;
      assert.equal(following.openingBalance, firstDay.closingBalance);
      const secondIncome = await add(
        entry(second, "INCOME", 3000000, "Khoản thu"),
      );
      assert.equal(secondIncome.status, 201);
      const secondExpense = await add(
        entry(second, "EXPENSE", 1000000, "Chi sự kiện"),
      );
      assert.equal(secondExpense.status, 201);
      manual = secondExpense.body.data;
      const summary = (await request("/summary" + range(first, second))).body
        .data;
      assert.deepEqual(
        [
          summary.openingBalance,
          summary.totalIncome,
          summary.totalExpense,
          summary.closingBalance,
        ],
        [20000000, 5000000, 1500000, 23500000],
      );
      const listed = (
        await request(
          "/daily" + range(first, second) + "&includeEmpty=true&limit=1&page=2",
        )
      ).body;
      assert.equal(listed.pagination.total, 3);
      assert.equal(listed.data[0].businessDate, empty);
      assert.equal(listed.data[0].openingBalance, 21500000);
      assert.equal(listed.data[0].closingBalance, 21500000);
      const filtered = (
        await request(
          "/daily" +
            range(first, second) +
            "&type=INCOME&q=" +
            encodeURIComponent("SUM(1+2)"),
        )
      ).body;
      assert.equal(filtered.pagination.total, 1);
      assert.equal(filtered.data[0].totalExpense, 500000);
      assert.equal(filtered.data[0].closingBalance, 21500000);
      const xlsx = await request(
        "/export" + range(first, second),
        "GET",
        undefined,
        staff,
      );
      assert.equal(xlsx.status, 200);
      assert.match(xlsx.headers.get("content-disposition"), /\.xlsx/);
      const parts = workbookParts(xlsx.body);
      assert.match(parts["xl/workbook.xml"], /Tổng hợp ngày/);
      assert.match(parts["xl/worksheets/sheet1.xml"], /<v>21500000<\/v>/);
      assert.match(
        parts["xl/worksheets/sheet2.xml"],
        /t="inlineStr"><is><t xml:space="preserve">=SUM\(1\+2\)/,
      );
      assert.doesNotMatch(parts["xl/worksheets/sheet2.xml"], /<f[ >]/);
    },
  );

  await t.test(
    "historical changes, ordered close, version checks, reversal and concurrent expenses",
    async () => {
      assert.equal(
        (await close(second)).body.code,
        "FINANCE_CLOSE_OUT_OF_ORDER",
      );
      assert.equal((await close(first, staff)).status, 403);
      const patched = await request(
        "/transactions/" + manual.id,
        "PATCH",
        { version: 1, amount: 500000, businessDate: first },
        staff,
      );
      assert.equal(patched.status, 200);
      assert.equal(
        (
          await request("/transactions/" + manual.id, "PATCH", {
            version: 1,
            amount: 100,
          })
        ).body.code,
        "FINANCE_VERSION_CONFLICT",
      );
      assert.equal(
        (await request("/daily/" + second)).body.data.openingBalance,
        21000000,
      );
      const firstClose = await close(first);
      assert.equal(firstClose.status, 200);
      assert.deepEqual((await close(first)).body.data, firstClose.body.data);
      assert.equal(
        (
          await request("/transactions/" + manual.id + "/void", "POST", {
            version: 2,
            reason: "Lỗi",
          })
        ).body.code,
        "FINANCE_DATE_CLOSED",
      );
      const secondClose = await close(second);
      assert.equal(secondClose.status, 200);
      assert.equal(secondClose.body.data.closingBalance, 24000000);
      assert.equal(
        (await request("/daily/" + empty)).body.data.status,
        "CLOSED",
      );
      const reversal = await reverse(manual.id, third, staff);
      assert.equal(reversal.status, 201, JSON.stringify(reversal.body));
      assert.equal(reversal.body.data.reversalOf, manual.id);
      const originalDay = await request("/daily/" + first);
      assert.deepEqual(
        originalDay.body.data.transactions.find((row) => row.id === manual.id)
          .reversal,
        {
          id: reversal.body.data.id,
          businessDate: third,
        },
      );
      assert.equal(
        (await reverse(manual.id, third)).body.code,
        "FINANCE_NOT_REVERSIBLE",
      );
      const adjustments = await request(
        "/transactions/" + manual.id + "/audit",
      );
      assert.deepEqual(
        adjustments.body.data.map((v) => v.action),
        ["CREATE", "UPDATE", "REVERSED"],
      );
      assert.equal(adjustments.body.data[1].before.amount, 1000000);
      const race = await Promise.all([
        add(entry(third, "EXPENSE", 20000000, "Chi 1")),
        add(entry(third, "EXPENSE", 20000000, "Chi 2")),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), [201, 422]);
      const posted = race.find((r) => r.status === 201).body.data;
      const preview = await request("/transactions/preview", "POST", {
        businessDate: third,
        type: "EXPENSE",
        amount: 5000000,
      });
      assert.equal(preview.body.data.allowed, false);
      assert.equal(preview.body.data.firstNegativeDate, third);
      assert.equal(preview.body.data.beforeBalance, 4500000);
      const later = await add(
        entry(day(-1), "EXPENSE", 4000000, "Khoản chi hôm sau"),
      );
      assert.equal(later.status, 201);
      assert.equal(
        (await add(entry(third, "EXPENSE", 600000, "Backdated"))).body.code,
        "FINANCE_INSUFFICIENT_FUNDS",
      );
      const voided = await request(
        "/transactions/" + posted.id + "/void",
        "POST",
        { version: 1, reason: "Nhập nhầm" },
      );
      assert.equal(voided.body.data.status, "VOIDED");
      assert.equal(
        (await request("/daily/" + third)).body.data.closingBalance,
        24500000,
      );
      assert.equal(
        (await request("/daily/" + day(-1))).body.data.closingBalance,
        20500000,
      );
    },
  );

  await t.test(
    "only receipts settle sources, duplicates rollback, and refunds keep history",
    async () => {
      const partner = await http("/admin/partners", "POST", {
        name: "Đối tác test",
        requestId: randomUUID(),
        isPublished: true,
      });
      assert.equal(partner.status, 201);
      const kind = await contribution(
        partner.body.data.id,
        "in_kind",
        "Hiện vật",
        { itemName: "Sách", quantity: 2 },
      );
      const money = await contribution(
        partner.body.data.id,
        "money",
        "Tiền tài trợ",
        { amount: 50000, paymentMethod: "cash" },
      );
      assert.equal(
        await app.locals.models.finance.entries.countDocuments({
          sourceType: "SPONSORSHIP",
        }),
        0,
      );
      const receive = (id, key = randomUUID(), token = admin) =>
        request(
          "/sponsorships/" + id + "/receive",
          "POST",
          { businessDate: third },
          token,
          key,
        );
      assert.equal(
        (await receive(kind)).body.code,
        "FINANCE_SPONSORSHIP_NOT_CASH",
      );
      assert.equal((await receive(money, randomUUID(), staff)).status, 403);
      const receiveKey = randomUUID();
      const received = await Promise.all([
        receive(money, receiveKey),
        receive(money, receiveKey),
      ]);
      assert.deepEqual(
        received.map((r) => r.status),
        [201, 201],
      );
      const sponsorship = received[0].body.data;
      assert.equal(received[1].body.data.id, sponsorship.id);
      assert.equal(sponsorship.amount, 50000);
      assert.equal(
        (await receive(money)).body.code,
        "FINANCE_SPONSORSHIP_ALREADY_RECEIVED",
      );
      assert.equal(
        (await http("/admin/contributions/" + money, "PATCH", { amount: 1000 }))
          .body.code,
        "FINANCE_SPONSORSHIP_LOCKED",
      );
      const publicRecord = await http(
        "/public/partners/" + partner.body.data.id,
        "GET",
        undefined,
        null,
      );
      assert.ok(
        publicRecord.body.data.contributions.every(
          (item) => !item.financeReceiptId,
        ),
      );
      assert.equal((await reverse(sponsorship.id, third, staff)).status, 403);
      assert.equal((await reverse(sponsorship.id, third)).status, 201);
      assert.ok(
        (await app.locals.models.partners.contributions.findById(money).lean())
          .financeRefundId,
      );

      const finance = app.locals.services.finance;
      const originalLog = finance.log.bind(finance);
      const brokenLog = t.mock.method(finance, "log", (...args) => {
        if (
          args[1] === "SOURCE_RECEIVED" &&
          args[3]?.sourceType === "MEMBERSHIP_FEE"
        )
          throw new Error("Finance audit unavailable");
        return originalLog(...args);
      });
      try {
        assert.equal((await pay(dues[1]._id, "FEE-NOW")).status, 500);
        assert.equal(
          (
            await app.locals.models.membershipFees.dues
              .findById(dues[1]._id)
              .lean()
          ).status,
          "unpaid",
        );
        assert.equal(
          await app.locals.models.finance.entries.countDocuments({
            sourceType: "MEMBERSHIP_FEE",
          }),
          0,
        );
      } finally {
        brokenLog.mock.restore();
      }
      const payment = await pay(dues[1]._id, "FEE-NOW");
      assert.equal(payment.status, 201);
      const feePayment = payment.body.data;
      const fee = await app.locals.models.finance.entries
        .findOne({ sourceId: feePayment.id })
        .lean();
      assert.equal(fee.amount, feePayment.amount);
      assert.equal(fee.businessDate, today);
      assert.equal((await pay(dues[2]._id, "FEE-NOW")).status, 409);
      assert.equal(
        await app.locals.models.finance.entries.countDocuments({
          sourceType: "MEMBERSHIP_FEE",
        }),
        1,
      );
      assert.equal(
        (
          await app.locals.models.membershipFees.dues
            .findById(dues[2]._id)
            .lean()
        ).status,
        "unpaid",
      );
      const refund = await reverse(fee._id, today);
      assert.equal(refund.status, 201);
      assert.equal(
        (
          await app.locals.models.membershipFees.dues
            .findById(dues[1]._id)
            .lean()
        ).status,
        "unpaid",
      );
    },
  );

  await t.test(
    "approved member proof posts once and late confirmed fees are queued",
    async () => {
      const secret = randomBytes(32).toString("hex");
      await app.locals.models.registrations.create({
        _id: "finance-registration",
        fullName: "Hội viên test",
        company: "Doanh nghiệp",
        phone: "0900000001",
        date: today,
        status: "approved",
        memberId: dues[1].memberId,
        notificationTokenHash: createHash("sha256")
          .update(secret)
          .digest("hex"),
      });
      const tokenResponse = await http(
        "/membership-fees/session",
        "POST",
        { tokens: [secret] },
        null,
      );
      assert.equal(
        tokenResponse.status,
        200,
        JSON.stringify(tokenResponse.body),
      );
      const token = tokenResponse.body.data.accessToken;
      assert.equal(
        (await request("/settings", "GET", undefined, token)).status,
        401,
      );
      const proofResult = await http(
        "/membership-fees/my-dues/" + dues[1]._id + "/payment-proof",
        "POST",
        {
          transactionRef: "FINANCE-MEMBER-PROOF",
          note: "Kiểm tra",
        },
        token,
      );
      assert.equal(proofResult.status, 201, JSON.stringify(proofResult.body));
      const paymentId = proofResult.body.data.id;
      assert.equal(
        await app.locals.models.finance.entries.countDocuments({
          sourceId: paymentId,
        }),
        0,
      );
      const confirms = await Promise.all(
        [1, 2].map(() =>
          http(
            "/admin/membership-fee-payments/" + paymentId + "/confirm",
            "POST",
            {},
          ),
        ),
      );
      assert.deepEqual(confirms.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        await app.locals.models.finance.entries.countDocuments({
          sourceId: paymentId,
        }),
        1,
      );

      assert.equal((await close(third)).status, 200);
      assert.equal((await close(day(-1))).status, 200);
      const snapshot = await close(today);
      assert.equal(snapshot.status, 200);
      const late = await pay(dues[2]._id, "FEE-AFTER-CUTOFF");
      assert.equal(late.status, 201, JSON.stringify(late.body));
      const pending = (await request("/pending-receipts")).body.data;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].sourceId, late.body.data.id);
      assert.equal(pending[0].postOn, day(1));
      assert.equal(
        (await request("/daily/" + today)).body.data.closingBalance,
        snapshot.body.data.closingBalance,
      );

      t.mock.timers.enable({
        apis: ["Date"],
        now: new Date(day(1) + "T05:00:00.000Z"),
      });
      try {
        admin = await login(
          process.env.ADMIN_USERNAME,
          process.env.ADMIN_PASSWORD,
        );
        const settled = (await request("/daily/" + day(1))).body.data;
        assert.equal(settled.openingBalance, snapshot.body.data.closingBalance);
        assert.equal(settled.totalIncome, late.body.data.amount);
        assert.equal(
          (await request("/pending-receipts")).body.pagination.total,
          0,
        );
        assert.equal(
          await app.locals.models.finance.entries.countDocuments({
            sourceId: late.body.data.id,
          }),
          1,
        );
      } finally {
        t.mock.timers.reset();
      }
    },
  );
});
