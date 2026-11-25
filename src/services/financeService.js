import { createHash, randomUUID } from "node:crypto";
import { financeSettingsId } from "../models/Finance.js";
import {
  prepareFinanceAttachments,
  storeFinanceAttachments,
} from "./financeAttachments.js";
import {
  change,
  effect,
  emptyTotals,
  entryOrder,
  financeError,
  financeToday,
  maxLedgerTotal,
  nextFinanceDay,
  pageResult,
  presentEntry,
  requireBookDate,
  requireOpening,
  requireOpenDate,
  totalsGroup,
} from "./financeShared.js";
import { FinanceReports } from "./financeReports.js";
import { refundMembershipFee, refundSponsorship } from "./financeSources.js";

const digest = (input) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const posted = { status: "POSTED" };
const settingsView = (row) =>
  row.openingDate
    ? {
        initialized: true,
        openingDate: row.openingDate,
        openingBalance: row.openingBalance,
        openingFeePaymentCount: row.openingFeePaymentCount,
        closedThrough: row.closedThrough ?? null,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      }
    : {
        initialized: false,
        openingDate: null,
        openingBalance: null,
        closedThrough: null,
      };

export class FinanceService {
  constructor(connection, models, { partners, membershipFees }) {
    this.connection = connection;
    Object.assign(this, models);
    this.partners = partners;
    this.membershipFees = membershipFees;
    this.reports = new FinanceReports(this);
  }

  async initialize() {
    await Promise.all(
      [
        "settings",
        "entries",
        "closes",
        "audit",
        "requests",
        "files",
        "pending",
      ].map((name) => this[name].init()),
    );
    try {
      await this.settings.updateOne(
        { _id: financeSettingsId },
        { $setOnInsert: { revision: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  async transaction(fn) {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => fn(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
    } finally {
      await session.endSession();
    }
  }

  async lock(session) {
    // Every ledger writer, including writers in other modules, takes this same lock.
    return this.settings
      .findByIdAndUpdate(
        financeSettingsId,
        { $inc: { revision: 1 } },
        { new: true, session },
      )
      .lean();
  }

  write(fn) {
    return this.transaction(async (session) => {
      const settings = await this.lock(session);
      await this.postDueReceipts(settings, session);
      return fn(settings, session);
    });
  }

  async read(fn) {
    const due = await this.pending.exists({ postOn: { $lte: financeToday() } });
    if (due) await this.write(() => undefined);
    return this.transaction(async (session) => {
      const settings = await this.settings
        .findById(financeSettingsId)
        .session(session)
        .lean();
      return fn(settings, session);
    });
  }

  async openingProposal(session, at) {
    // Existing confirmed payments were collected before the ledger started.
    // Sponsorship posts do not prove receipt; confirmed sponsorships post directly into the ledger.
    const [received] = await this.membershipFees.payments
      .aggregate([
        {
          $match: {
            status: "confirmed",
            financeRefundId: null,
            amount: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: null,
            balance: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ])
      .session(session);
    return {
      openingDate: financeToday(at),
      openingBalance: received?.balance ?? 0,
      feePaymentCount: received?.count ?? 0,
    };
  }

  async getSettings() {
    const settings = await this.settings.findById(financeSettingsId).lean();
    if (settings.openingDate) return { data: settingsView(settings) };
    return this.transaction(async (session) => {
      const snapshot = await this.settings
        .findById(financeSettingsId)
        .session(session)
        .lean();
      const data = settingsView(snapshot);
      if (!data.initialized)
        data.openingProposal = await this.openingProposal(session, new Date());
      return { data };
    });
  }

  open(input, actorId) {
    return this.write(async (settings, session) => {
      if (settings.openingDate)
        throw financeError(
          409,
          "FINANCE_ALREADY_INITIALIZED",
          "Sổ quỹ đã được thiết lập.",
        );
      const at = new Date();
      // The fee confirmation flow takes this same ledger lock before committing.
      const proposal = await this.openingProposal(session, at);
      if (
        !Number.isSafeInteger(proposal.openingBalance) ||
        proposal.openingBalance > maxLedgerTotal
      )
        throw financeError(
          422,
          "FINANCE_TOTAL_LIMIT",
          "Số tiền đã thu vượt giới hạn sổ quỹ.",
        );
      if (
        input.expectedOpeningDate !== proposal.openingDate ||
        input.expectedOpeningBalance !== proposal.openingBalance
      )
        throw financeError(
          409,
          "FINANCE_OPENING_CHANGED",
          "Ngày mở sổ hoặc số tiền đã thu vừa thay đổi. Hãy tải lại và kiểm tra số dư.",
        );
      const next = {
        openingDate: proposal.openingDate,
        openingBalance: proposal.openingBalance,
        openingFeePaymentCount: proposal.feePaymentCount,
        createdBy: actorId,
        createdAt: at,
      };
      await this.settings.updateOne(
        { _id: settings._id },
        { $set: next },
        { session },
      );
      await this.log(
        settings._id,
        "OPEN_LEDGER",
        null,
        next,
        actorId,
        "",
        session,
      );
      return { data: settingsView(next) };
    });
  }

  async once(action, actorId, key, input, session, fn) {
    const id = digest([action, actorId, key]);
    const hash = digest(input);
    const existing = await this.requests.findById(id).session(session).lean();
    if (existing) {
      if (existing.hash !== hash)
        throw financeError(
          409,
          "FINANCE_IDEMPOTENCY_CONFLICT",
          "Mã yêu cầu đã được dùng với dữ liệu khác.",
        );
      return existing.response;
    }
    const response = await fn();
    await this.requests.create([{ _id: id, hash, response }], { session });
    return response;
  }

  async log(entityId, action, before, after, actorId, reason, session) {
    await this.audit.create(
      [
        {
          entityId,
          action,
          before,
          after,
          actorId,
          reason,
          createdAt: new Date(),
        },
      ],
      { session },
    );
  }

  async entry(id, session) {
    const row = await this.entries.findById(id).session(session).lean();
    if (!row)
      throw financeError(
        404,
        "FINANCE_ENTRY_NOT_FOUND",
        "Không tìm thấy phiếu.",
      );
    return row;
  }

  async add(
    input,
    actorId,
    session,
    action = "CREATE",
    reason = "",
    prepared = [],
  ) {
    const id = randomUUID();
    const attachments = await storeFinanceAttachments(
      this.files,
      id,
      prepared,
      session,
    );
    const [entry] = await this.entries.create(
      [
        {
          ...input,
          _id: id,
          code: "TC-" + id.toUpperCase(),
          attachments,
          createdBy: actorId,
          updatedBy: actorId,
        },
      ],
      { session },
    );
    const result = presentEntry(entry.toObject());
    await this.log(id, action, null, result, actorId, reason, session);
    return result;
  }

  create(input, actorId, key) {
    const { attachments, ...fields } = input;
    const files = prepareFinanceAttachments(attachments);
    return this.write((settings, session) =>
      this.once("CREATE", actorId, key, input, session, async () => {
        requireOpenDate(settings, fields.businessDate);
        const data = await this.add(
          { ...fields, sourceType: "MANUAL" },
          actorId,
          session,
          "CREATE",
          "",
          files,
        );
        await this.requireBalances(settings, fields.businessDate, session);
        return { data };
      }),
    );
  }

  async update(id, input, actorId) {
    const { version, attachments, retainAttachmentIds, ...fields } = input;
    const prepared = prepareFinanceAttachments(attachments);
    return this.write(async (settings, session) => {
      const before = await this.editableEntry(id, version, settings, session);
      const date = fields.businessDate ?? before.businessDate;
      requireOpenDate(settings, date);
      const retained =
        retainAttachmentIds === undefined
          ? before.attachments
          : before.attachments.filter((file) =>
              retainAttachmentIds.includes(file.id),
            );
      if (
        (retainAttachmentIds &&
          (new Set(retainAttachmentIds).size !== retainAttachmentIds.length ||
            retained.length !== retainAttachmentIds.length)) ||
        retained.length + prepared.length > 3
      )
        throw financeError(
          400,
          "FINANCE_INVALID_ATTACHMENTS",
          "Chứng từ giữ lại không hợp lệ hoặc tổng số vượt quá 3.",
        );
      const newFiles = await storeFinanceAttachments(
        this.files,
        id,
        prepared,
        session,
      );
      const row = await this.entries
        .findByIdAndUpdate(
          id,
          {
            $set: {
              ...fields,
              attachments: [...retained, ...newFiles],
              updatedBy: actorId,
            },
            $inc: { version: 1 },
          },
          { new: true, session, runValidators: true },
        )
        .lean();
      await this.requireBalances(
        settings,
        date < before.businessDate ? date : before.businessDate,
        session,
      );
      const data = presentEntry(row);
      await this.log(
        id,
        "UPDATE",
        presentEntry(before),
        data,
        actorId,
        "",
        session,
      );
      return { data };
    });
  }

  async editableEntry(id, version, settings, session) {
    const row = await this.entry(id, session);
    requireOpenDate(settings, row.businessDate);
    if (row.version !== version)
      throw financeError(
        409,
        "FINANCE_VERSION_CONFLICT",
        "Phiếu vừa thay đổi. Vui lòng tải lại.",
      );
    if (
      row.status !== "POSTED" ||
      row.sourceType !== "MANUAL" ||
      (await this.entries.exists({ reversalOf: id }).session(session))
    )
      throw financeError(
        409,
        "FINANCE_ENTRY_LOCKED",
        "Chỉ sửa hoặc hủy phiếu thủ công đang ghi sổ và chưa đảo.",
      );
    return row;
  }

  void(id, input, actorId) {
    return this.write(async (settings, session) => {
      const before = await this.editableEntry(
        id,
        input.version,
        settings,
        session,
      );
      const row = await this.entries
        .findByIdAndUpdate(
          id,
          {
            $set: { status: "VOIDED", updatedBy: actorId },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean();
      await this.requireBalances(settings, before.businessDate, session);
      const data = presentEntry(row);
      await this.log(
        id,
        "VOID",
        presentEntry(before),
        data,
        actorId,
        input.reason,
        session,
      );
      return { data };
    });
  }

  reverse(id, input, actor, key) {
    return this.write((settings, session) =>
      this.once(
        "REVERSE",
        actor.id,
        key,
        { id, ...input },
        session,
        async () => {
          const original = await this.entry(id, session);
          requireOpenDate(settings, input.businessDate);
          if (input.businessDate < original.businessDate)
            throw financeError(
              422,
              "FINANCE_REVERSAL_DATE",
              "Ngày đảo không được trước ngày phiếu gốc.",
            );
          if (
            original.status !== "POSTED" ||
            original.reversalOf ||
            (await this.entries.exists({ reversalOf: id }).session(session))
          )
            throw financeError(
              409,
              "FINANCE_NOT_REVERSIBLE",
              "Phiếu này không thể đảo hoặc đã có phiếu đảo.",
            );
          if (original.sourceType !== "MANUAL" && actor.role !== "SUPER_ADMIN")
            throw financeError(
              403,
              "FINANCE_FORBIDDEN",
              "Chỉ quản trị viên cấp cao được hoàn tiền từ nguồn liên kết.",
            );
          const data = await this.add(
            {
              businessDate: input.businessDate,
              type: original.type === "INCOME" ? "EXPENSE" : "INCOME",
              amount: original.amount,
              content: ("Đảo phiếu: " + original.content).slice(0, 1000),
              category: original.category,
              paymentMethod: original.paymentMethod,
              counterparty: original.counterparty,
              referenceNo: original.code,
              note: input.reason,
              sourceType: "ADJUSTMENT",
              sourceId: original.sourceId ?? id,
              sourceEventKey: original.sourceEventKey
                ? original.sourceEventKey + ":reverse"
                : undefined,
              reversalOf: id,
            },
            actor.id,
            session,
            "REVERSE",
            input.reason,
          );
          await this.requireBalances(settings, input.businessDate, session);
          if (original.sourceType === "MEMBERSHIP_FEE")
            await refundMembershipFee(
              this.membershipFees,
              original.sourceId,
              data,
              actor.id,
              session,
            );
          if (original.sourceType === "SPONSORSHIP")
            await refundSponsorship(
              this.partners.contributions,
              original.sourceId,
              data,
              actor.id,
              session,
            );
          await this.log(
            id,
            "REVERSED",
            presentEntry(original),
            { reversalId: data.id },
            actor.id,
            input.reason,
            session,
          );
          return { data };
        },
      ),
    );
  }

  close(date, actorId) {
    return this.write(async (settings, session) => {
      requireBookDate(settings, date);
      const existing = await this.closes.findById(date).session(session).lean();
      if (existing) return { data: this.closedDay(existing) };
      requireOpenDate(settings, date);
      const earlier = await this.entries
        .exists({
          ...posted,
          businessDate: {
            $lt: date,
            ...(settings.closedThrough ? { $gt: settings.closedThrough } : {}),
          },
        })
        .session(session);
      if (earlier)
        throw financeError(
          409,
          "FINANCE_CLOSE_OUT_OF_ORDER",
          "Cần chốt ngày có giao dịch phát sinh trước ngày này.",
        );
      const openingBalance =
        settings.openingBalance +
        change(await this.totalsBefore(date, session));
      const totals = await this.entries
        .aggregate([
          { $match: { ...posted, businessDate: date } },
          { $group: { _id: null, ...totalsGroup } },
          { $project: { _id: 0 } },
        ])
        .session(session);
      const dayTotals = totals[0] ?? emptyTotals();
      await this.requireBalances(settings, date, session);
      const snapshot = {
        _id: date,
        openingBalance,
        ...dayTotals,
        closingBalance: openingBalance + change(dayTotals),
        closedBy: actorId,
        closedAt: new Date(),
      };
      await this.closes.create([snapshot], { session });
      await this.settings.updateOne(
        { _id: settings._id },
        { $set: { closedThrough: date } },
        { session },
      );
      const data = this.closedDay(snapshot);
      await this.log(date, "CLOSE_DAY", null, data, actorId, "", session);
      return { data };
    });
  }

  closedDay({ _id, ...snapshot }) {
    return { businessDate: _id, status: "CLOSED", ...snapshot };
  }

  async totalsBefore(date, session) {
    const [row] = await this.entries
      .aggregate([
        { $match: { ...posted, businessDate: { $lt: date } } },
        { $group: { _id: null, ...totalsGroup } },
        { $project: { _id: 0 } },
      ])
      .session(session);
    return row ?? emptyTotals();
  }

  async balanceCheck(settings, from, session, proposed) {
    const dates = await this.entries
      .aggregate([
        { $match: { ...posted, businessDate: { $gte: from } } },
        { $group: { _id: "$businessDate", ...totalsGroup } },
        { $sort: { _id: 1 } },
      ])
      .session(session);
    const before = await this.totalsBefore(from, session);
    const first = dates[0]?._id === from ? dates[0] : emptyTotals();
    const beforeAmount =
      settings.openingBalance + change(before) + change(first);
    let balance = settings.openingBalance + change(before);
    let income = before.totalIncome;
    let expense = before.totalExpense;
    let firstNegativeDate = null;
    if (proposed && dates[0]?._id !== from)
      dates.unshift({ _id: from, ...emptyTotals() });
    for (const day of dates) {
      const extra = day._id === from && proposed;
      income += day.totalIncome + (extra?.type === "INCOME" ? extra.amount : 0);
      expense +=
        day.totalExpense + (extra?.type === "EXPENSE" ? extra.amount : 0);
      balance = settings.openingBalance + income - expense;
      if (balance < 0 && !firstNegativeDate) firstNegativeDate = day._id;
    }
    return {
      beforeBalance: beforeAmount,
      afterBalance: beforeAmount + (proposed ? effect(proposed) : 0),
      firstNegativeDate,
      withinLimit:
        settings.openingBalance + income <= maxLedgerTotal &&
        expense <= maxLedgerTotal,
    };
  }

  async requireBalances(settings, date, session) {
    const result = await this.balanceCheck(settings, date, session);
    if (!result.withinLimit)
      throw financeError(
        422,
        "FINANCE_TOTAL_LIMIT",
        "Tổng sổ quỹ vượt giới hạn VND có thể biểu diễn chính xác.",
      );
    if (result.firstNegativeDate)
      throw financeError(
        422,
        "FINANCE_INSUFFICIENT_FUNDS",
        "Số dư cuối ngày không đủ vào " + result.firstNegativeDate + ".",
      );
  }

  preview(input) {
    return this.read(async (settings, session) => {
      requireOpenDate(settings, input.businessDate);
      const result = await this.balanceCheck(
        settings,
        input.businessDate,
        session,
        input,
      );
      return {
        data: {
          businessDate: input.businessDate,
          ...result,
          allowed: result.withinLimit && !result.firstNegativeDate,
        },
      };
    });
  }

  async history(id, query) {
    return this.read(async (settings, session) => {
      await this.entry(id, session);
      const filter = { entityId: id };
      const total = await this.audit.countDocuments(filter).session(session);
      const rows = await this.audit
        .find(filter)
        .sort(entryOrder)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .session(session)
        .lean();
      return pageResult(
        rows.map(({ _id, ...row }) => ({ id: String(_id), ...row })),
        query,
        total,
      );
    });
  }

  async attachment(id, fileId) {
    const file = await this.files.findOne({ _id: fileId, entryId: id });
    if (!file)
      throw financeError(
        404,
        "FINANCE_ATTACHMENT_NOT_FOUND",
        "Không tìm thấy chứng từ.",
      );
    return file;
  }

  async postSource(settings, input, actorId, session) {
    requireOpenDate(settings, input.businessDate);
    const data = await this.add(input, actorId, session, "SOURCE_RECEIVED");
    await this.requireBalances(settings, input.businessDate, session);
    return data;
  }

  async recordFeeReceipt(payment, campaign, session) {
    const settings = await this.lock(session);
    if (!settings.openingDate) return;
    await this.postDueReceipts(settings, session);
    const businessDate = financeToday(payment.confirmedAt);
    const receipt = {
      businessDate,
      type: "INCOME",
      amount: payment.amount,
      content: "Thu hội phí: " + campaign.title,
      category: "MEMBERSHIP_FEE",
      paymentMethod: payment.method === "cash" ? "CASH" : "BANK_TRANSFER",
      referenceNo: payment.transactionRef,
      sourceType: "MEMBERSHIP_FEE",
      sourceId: payment._id,
      sourceEventKey: "MEMBERSHIP_FEE:" + payment._id + ":received",
    };
    if (settings.closedThrough && businessDate <= settings.closedThrough) {
      await this.pending.create(
        [
          {
            _id: receipt.sourceEventKey,
            postOn: nextFinanceDay(settings.closedThrough),
            receipt: { ...receipt, actorId: payment.confirmedBy },
            createdAt: payment.confirmedAt,
          },
        ],
        { session },
      );
      return;
    }
    await this.postSource(settings, receipt, payment.confirmedBy, session);
  }

  async postDueReceipts(settings, session) {
    if (!settings.openingDate) return;
    const rows = await this.pending
      .find({ postOn: { $lte: financeToday() } })
      .sort({ postOn: 1, _id: 1 })
      .session(session)
      .lean();
    for (const { _id, postOn, receipt } of rows) {
      const { actorId, businessDate, ...fields } = receipt;
      await this.add(
        { ...fields, businessDate: postOn },
        actorId,
        session,
        "SOURCE_RECEIVED",
        "Thực nhận ngày " + businessDate + " sau khi chốt sổ.",
        [],
      );
      await this.pending.deleteOne({ _id }, { session });
    }
    if (rows.length)
      await this.requireBalances(settings, rows[0].postOn, session);
  }

  async pendingReceipts(query) {
    return this.read(async (settings, session) => {
      requireOpening(settings);
      const total = await this.pending.countDocuments().session(session);
      const rows = await this.pending
        .find()
        .sort({ postOn: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .session(session)
        .lean();
      return pageResult(
        rows.map(({ _id: id, postOn, createdAt, receipt }) => ({
          id,
          postOn,
          createdAt,
          receivedOn: receipt.businessDate,
          amount: receipt.amount,
          sourceType: receipt.sourceType,
          sourceId: receipt.sourceId,
          referenceNo: receipt.referenceNo,
        })),
        query,
        total,
      );
    });
  }
}
