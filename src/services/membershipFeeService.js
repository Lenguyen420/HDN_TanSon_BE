import { randomUUID } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
const present = ({ _id, __v, transactionKey, ...row }) => ({ id: _id, ...row });
const memberCampaign = (c) =>
  Object.fromEntries(
    [
      "title",
      "year",
      "amount",
      "dueDate",
      "description",
      "paymentInstructions",
      "status",
    ]
      .map((k) => [k, c[k]])
      .concat([["id", c._id]]),
  );
const log = (action, actorId, note = "") => ({
  action,
  actorId,
  note,
  at: new Date(),
});
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
const escaped = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export class MembershipFeeService {
  constructor(connection, models, members) {
    this.connection = connection;
    Object.assign(this, models);
    this.members = members;
  }
  async initialize() {
    await Promise.all([
      this.campaigns.init(),
      this.dues.init(),
      this.payments.init(),
    ]);
  }
  async transaction(fn) {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  }
  async campaign(id, session) {
    const row = await this.campaigns
      .findById(id)
      .session(session || null)
      .lean();
    if (!row) throw new HttpError(404, "Không tìm thấy đợt hội phí.");
    return row;
  }
  async lock(id, session) {
    const row = await this.campaigns
      .findOneAndUpdate(
        { _id: id },
        { $inc: { revision: 1 } },
        { new: true, session },
      )
      .lean();
    if (!row) throw new HttpError(404, "Không tìm thấy đợt hội phí.");
    return row;
  }
  status(due, campaign) {
    return due.status === "unpaid" && campaign.dueDate < today()
      ? "overdue"
      : due.status;
  }
  summary(rows, campaign) {
    const counts = {
      total: rows.length,
      paid: 0,
      unpaid: 0,
      overdue: 0,
      pending_confirmation: 0,
      cancelled: 0,
      paidAmount: 0,
      remainingAmount: 0,
    };
    for (const row of rows) {
      counts[this.status(row, campaign)]++;
      if (row.status === "paid") counts.paidAmount += row.amountDue;
      else if (row.status !== "cancelled")
        counts.remainingAmount += row.amountDue;
    }
    return counts;
  }
  async list(query) {
    const filter = {};
    if (query.year) filter.year = query.year;
    if (query.status) filter.status = query.status;
    if (query.search)
      filter.title = { $regex: escaped(query.search), $options: "i" };
    const [rows, total] = await Promise.all([
      this.campaigns
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.campaigns.countDocuments(filter),
    ]);
    const dues = await this.dues
      .find({ campaignId: { $in: rows.map((r) => r._id) } })
      .lean();
    return {
      data: rows.map((row) => ({
        ...present(row),
        summary: this.summary(
          dues.filter((d) => d.campaignId === row._id),
          row,
        ),
      })),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async assign(campaign, session, actorId) {
    const filter = { status: "active", deletedAt: null };
    if (campaign.target === "selected")
      filter._id = { $in: campaign.targetMemberIds };
    const members = await this.members.find(filter).session(session).lean();
    if (
      !members.length ||
      (campaign.target === "selected" &&
        members.length !== new Set(campaign.targetMemberIds).size)
    )
      throw new HttpError(
        400,
        "Vui lòng chọn hội viên đang hoạt động; có hồ sơ không còn hợp lệ.",
      );
    await this.dues.bulkWrite(
      members.map((member) => ({
        updateOne: {
          filter: { campaignId: campaign._id, memberId: member._id },
          update: {
            $setOnInsert: {
              _id: randomUUID(),
              campaignId: campaign._id,
              memberId: member._id,
              amountDue: campaign.amount,
              status: "unpaid",
              audit: [log("assigned", actorId)],
            },
          },
          upsert: true,
        },
      })),
      { session },
    );
  }
  async create(dto, actorId) {
    return this.transaction(async (session) => {
      const [row] = await this.campaigns.create(
        [
          {
            ...dto,
            targetMemberIds: [...new Set(dto.targetMemberIds)],
            _id: randomUUID(),
            createdBy: actorId,
            audit: [
              log("created", actorId),
              ...(dto.status === "published"
                ? [log("published", actorId)]
                : []),
            ],
          },
        ],
        { session },
      );
      if (dto.status === "published") await this.assign(row, session, actorId);
      return { data: present(row.toObject()) };
    });
  }
  async publish(id, actorId) {
    return this.transaction(async (session) => {
      const row = await this.lock(id, session);
      if (row.status === "published") return { data: present(row) };
      if (row.status !== "draft") throw new HttpError(409, "Đợt thu đã ngừng.");
      await this.assign(row, session, actorId);
      const updated = await this.campaigns
        .findByIdAndUpdate(
          id,
          {
            $set: { status: "published" },
            $push: { audit: log("published", actorId) },
          },
          { new: true, session },
        )
        .lean();
      return { data: present(updated) };
    });
  }
  async update(id, dto, actorId) {
    return this.transaction(async (session) => {
      const row = await this.lock(id, session);
      if (row.status === "closed")
        throw new HttpError(409, "Đợt thu đã ngừng, không thể sửa.");
      const financial = ["amount", "target", "targetMemberIds", "year"];
      if (
        row.status !== "draft" &&
        (financial.some((k) => k in dto) || dto.status === "draft")
      )
        throw new HttpError(
          409,
          "Chỉ sửa số tiền, năm và đối tượng khi đợt thu còn là bản nháp.",
        );
      const next = { ...row, ...dto };
      if (next.target === "selected" && !next.targetMemberIds.length)
        throw new HttpError(400, "Vui lòng chọn hội viên.");
      if (dto.status === "closed") {
        const dues = await this.dues
          .find({
            campaignId: id,
            status: { $in: ["unpaid", "pending_confirmation"] },
          })
          .session(session)
          .lean();
        const ids = dues.map((d) => d._id);
        await this.payments.updateMany(
          { dueId: { $in: ids }, status: "pending" },
          {
            $set: { status: "rejected" },
            $push: { audit: log("campaign_closed", actorId) },
          },
          { session },
        );
        await this.dues.updateMany(
          { _id: { $in: ids } },
          {
            $set: { status: "cancelled" },
            $push: { audit: log("cancelled", actorId) },
          },
          { session },
        );
      }
      const updated = await this.campaigns
        .findByIdAndUpdate(
          id,
          {
            $set: dto,
            $push: {
              audit: log(
                dto.status === "closed" ? "closed" : "updated",
                actorId,
              ),
            },
          },
          { new: true, session },
        )
        .lean();
      return { data: present(updated) };
    });
  }
  async listDues(id, query) {
    const campaign = await this.campaign(id);
    const all = await this.dues
      .find({ campaignId: id })
      .sort({ memberId: 1 })
      .lean();
    const members = await this.members
      .find({ _id: { $in: all.map((d) => d.memberId) } })
      .select("_id name company")
      .lean();
    const memberMap = new Map(members.map((m) => [m._id, m]));
    let rows = all.map((d) => ({
      ...present(d),
      status: this.status(d, campaign),
      paidAmount: d.status === "paid" ? d.amountDue : 0,
      member: memberMap.has(d.memberId)
        ? present(memberMap.get(d.memberId))
        : { id: d.memberId, name: d.memberId },
    }));
    if (query.status) rows = rows.filter((d) => d.status === query.status);
    if (query.search)
      rows = rows.filter((d) =>
        (d.member.name + " " + d.memberId)
          .toLocaleLowerCase("vi")
          .includes(query.search.toLocaleLowerCase("vi")),
      );
    const total = rows.length;
    rows = rows.slice((query.page - 1) * query.limit, query.page * query.limit);
    const payments = await this.payments
      .find({ dueId: { $in: rows.map((d) => d.id) } })
      .sort({ createdAt: -1 })
      .lean();
    return {
      data: rows.map((d) => ({
        ...d,
        payments: payments.filter((p) => p.dueId === d.id).map(present),
      })),
      campaign: present(campaign),
      summary: this.summary(all, campaign),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async myDues(memberId, query) {
    const all = await this.dues
      .find({ memberId })
      .sort({ createdAt: -1, _id: 1 })
      .lean();
    const campaigns = await this.campaigns
      .find({ _id: { $in: all.map((d) => d.campaignId) } })
      .lean();
    const rows = all.flatMap((d) => {
      const c = campaigns.find((c) => c._id === d.campaignId);
      return c
        ? [
            {
              ...present(d),
              status: this.status(d, c),
              campaign: memberCampaign(c),
              paidAmount: d.status === "paid" ? d.amountDue : 0,
            },
          ]
        : [];
    });
    return {
      data: rows.slice(
        (query.page - 1) * query.limit,
        query.page * query.limit,
      ),
      pagination: { page: query.page, limit: query.limit, total: rows.length },
    };
  }
  async myDue(id, memberId) {
    const due = await this.dues.findOne({ _id: id, memberId }).lean();
    if (!due) throw new HttpError(404, "Không tìm thấy khoản hội phí.");
    const campaign = await this.campaign(due.campaignId);
    const payments = await this.payments
      .find({ dueId: id, memberId })
      .sort({ createdAt: -1 })
      .lean();
    return {
      data: {
        ...present(due),
        status: this.status(due, campaign),
        campaign: memberCampaign(campaign),
        payments: payments.map(present),
      },
    };
  }
  async submit(id, memberId, dto) {
    return this.transaction(async (session) => {
      const due = await this.dues
        .findOne({ _id: id, memberId })
        .session(session)
        .lean();
      if (!due) throw new HttpError(404, "Không tìm thấy khoản hội phí.");
      const campaign = await this.lock(due.campaignId, session);
      if (campaign.status !== "published" || due.status !== "unpaid")
        throw new HttpError(
          409,
          "Khoản phí đã xử lý, đang chờ xác nhận hoặc đã ngừng thu.",
        );
      const [payment] = await this.payments.create(
        [
          {
            ...dto,
            _id: randomUUID(),
            dueId: id,
            memberId,
            amount: due.amountDue,
            method: "bank_transfer",
            status: "pending",
            audit: [log("submitted", memberId)],
          },
        ],
        { session },
      );
      await this.dues.updateOne(
        { _id: id },
        {
          $set: { status: "pending_confirmation" },
          $push: { audit: log("proof_submitted", memberId) },
        },
        { session },
      );
      return { data: present(payment.toObject()) };
    });
  }
  async decide(id, confirmed, dto, actorId) {
    return this.transaction(async (session) => {
      const payment = await this.payments.findById(id).session(session).lean();
      if (!payment) throw new HttpError(404, "Không tìm thấy thanh toán.");
      const due = await this.dues
        .findById(payment.dueId)
        .session(session)
        .lean();
      await this.lock(due.campaignId, session);
      if (payment.status !== "pending" || due.status !== "pending_confirmation")
        throw new HttpError(409, "Thanh toán đã được xử lý.");
      const at = new Date(),
        action = confirmed ? "confirmed" : "rejected";
      const update = {
        status: action,
        confirmedBy: actorId,
        confirmedAt: at,
        ...(confirmed
          ? { transactionKey: payment.transactionRef.trim().toUpperCase() }
          : {}),
      };
      const row = await this.payments
        .findByIdAndUpdate(
          id,
          { $set: update, $push: { audit: log(action, actorId, dto.note) } },
          { new: true, session },
        )
        .lean();
      await this.dues.updateOne(
        { _id: due._id },
        {
          $set: confirmed
            ? {
                status: "paid",
                paidAt: at,
                confirmedBy: actorId,
                paymentMethod: payment.method,
                transactionRef: payment.transactionRef,
              }
            : { status: "unpaid" },
          $push: { audit: log(action, actorId, dto.note) },
        },
        { session },
      );
      return { data: present(row) };
    });
  }
  async manual(id, dto, actorId) {
    return this.transaction(async (session) => {
      const due = await this.dues.findById(id).session(session).lean();
      if (!due) throw new HttpError(404, "Không tìm thấy khoản hội phí.");
      const campaign = await this.lock(due.campaignId, session);
      if (campaign.status !== "published" || due.status !== "unpaid")
        throw new HttpError(
          409,
          "Chỉ ghi nhận thủ công khoản chưa đóng đang mở thu.",
        );
      const at = new Date();
      const [payment] = await this.payments.create(
        [
          {
            ...dto,
            _id: randomUUID(),
            dueId: id,
            memberId: due.memberId,
            amount: due.amountDue,
            status: "confirmed",
            transactionKey: dto.transactionRef.trim().toUpperCase(),
            confirmedBy: actorId,
            confirmedAt: at,
            audit: [log("manual_confirmed", actorId, dto.note)],
          },
        ],
        { session },
      );
      await this.dues.updateOne(
        { _id: id },
        {
          $set: {
            status: "paid",
            paidAt: at,
            confirmedBy: actorId,
            paymentMethod: dto.method,
            transactionRef: dto.transactionRef,
          },
          $push: { audit: log("manual_confirmed", actorId, dto.note) },
        },
        { session },
      );
      return { data: present(payment.toObject()) };
    });
  }
}
