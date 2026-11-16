import { createHash } from "node:crypto";
import { contributionData } from "../dto/partner.dto.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../utils/httpError.js";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicFields = {
  requestHash: 0,
  audit: 0,
  createdBy: 0,
  updatedBy: 0,
  notification: 0,
  memberId: 0,
  deletedAt: 0,
};
const output = (row) => {
  const { _id, ...rest } = row;
  return { id: _id, ...rest };
};
const audit = (action, actorId) => ({ action, actorId, at: new Date() });
export class PartnerService {
  constructor(models, members, events, images) {
    Object.assign(this, models);
    this.members = members;
    this.events = events;
    this.images = images;
  }
  async initialize() {
    await Promise.all([this.partners.init(), this.contributions.init()]);
  }
  async partner(id, admin = false) {
    const row = await this.partners
      .findOne({
        _id: id,
        deletedAt: null,
        ...(!admin ? { isPublished: true } : {}),
      })
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy đơn vị đồng hành.");
    return row;
  }
  async references(data) {
    if (
      data.memberId &&
      !(await this.members.exists({ _id: data.memberId, deletedAt: null }))
    )
      throw new BadRequestError("Hội viên liên kết không tồn tại.");
    if (
      data.eventId &&
      !(await this.events.exists({ _id: data.eventId, deletedAt: null }))
    )
      throw new BadRequestError("Sự kiện không tồn tại.");
  }
  totals(from, to) {
    return [
      {
        $match: {
          deletedAt: null,
          isPublished: true,
          ...(from || to
            ? {
                contributionDate: {
                  ...(from ? { $gte: from } : {}),
                  ...(to ? { $lte: to } : {}),
                },
              }
            : {}),
        },
      },
      {
        $group: {
          _id: "$partnerId",
          totalAmount: {
            $sum: { $cond: [{ $eq: ["$type", "money"] }, "$amount", 0] },
          },
          contributionCount: { $sum: 1 },
          inKindCount: {
            $sum: { $cond: [{ $eq: ["$type", "in_kind"] }, 1, 0] },
          },
          estimatedValue: {
            $sum: {
              $cond: [
                { $eq: ["$type", "in_kind"] },
                { $ifNull: ["$estimatedValue", 0] },
                0,
              ],
            },
          },
        },
      },
    ];
  }
  async statistics(query = {}, admin = false) {
    const rows = await this.contributions.aggregate([
      ...this.totals(query.from, query.to),
      {
        $lookup: {
          from: "partners",
          localField: "_id",
          foreignField: "_id",
          as: "partner",
        },
      },
      { $unwind: "$partner" },
      { $match: { "partner.deletedAt": null, "partner.isPublished": true } },
      {
        $project: {
          _id: 0,
          partnerId: "$_id",
          name: "$partner.name",
          totalAmount: 1,
          contributionCount: 1,
          inKindCount: 1,
          estimatedValue: 1,
        },
      },
      { $sort: { totalAmount: -1, partnerId: 1 } },
    ]);
    return {
      totalPartners: await this.partners.countDocuments({
        deletedAt: null,
        ...(!admin ? { isPublished: true } : {}),
      }),
      totalAmount: rows.reduce((n, r) => n + r.totalAmount, 0),
      contributionCount: rows.reduce((n, r) => n + r.contributionCount, 0),
      inKindCount: rows.reduce((n, r) => n + r.inKindCount, 0),
      estimatedValue: rows.reduce((n, r) => n + r.estimatedValue, 0),
      ...(admin ? { byPartner: rows } : {}),
    };
  }
  async list(query, admin = false) {
    const filter = {
      deletedAt: null,
      ...(!admin
        ? { isPublished: true }
        : query.isPublished
          ? { isPublished: query.isPublished === "true" }
          : {}),
      ...(query.search
        ? {
            name: {
              $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              $options: "i",
            },
          }
        : {}),
    };
    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: "partner_contributions",
          let: { partnerId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$partnerId", "$$partnerId"] } } },
            ...this.totals(),
          ],
          as: "totals",
        },
      },
      {
        $set: {
          totalAmount: { $ifNull: [{ $first: "$totals.totalAmount" }, 0] },
          contributionCount: {
            $ifNull: [{ $first: "$totals.contributionCount" }, 0],
          },
        },
      },
      {
        $project: {
          totals: 0,
          requestHash: 0,
          ...(!admin ? publicFields : {}),
        },
      },
      {
        $sort:
          query.sort === "name"
            ? { name: 1, _id: 1 }
            : query.sort === "updated"
              ? { updatedAt: -1, _id: 1 }
              : { totalAmount: -1, _id: 1 },
      },
      {
        $facet: {
          data: [
            { $skip: (query.page - 1) * query.limit },
            { $limit: query.limit },
          ],
          total: [{ $count: "count" }],
        },
      },
    ];
    const [result] = await this.partners.aggregate(pipeline);
    return {
      data: result.data.map(output),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total[0]?.count || 0,
      },
      summary: await this.statistics({}, admin),
    };
  }
  async detail(id, query, admin = false) {
    const row = await this.partner(id, admin);
    const filter = {
      partnerId: id,
      deletedAt: null,
      ...(!admin ? { isPublished: true } : {}),
    };
    const [history, count, totals] = await Promise.all([
      this.contributions
        .find(filter, admin ? { requestHash: 0 } : publicFields)
        .sort({ contributionDate: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.contributions.countDocuments(filter),
      this.contributions.aggregate([
        { $match: { partnerId: id } },
        ...this.totals(),
      ]),
    ]);
    for (const key of Object.keys(admin ? { requestHash: 0 } : publicFields))
      delete row[key];
    return {
      data: {
        ...output(row),
        totalAmount: totals[0]?.totalAmount || 0,
        contributionCount: totals[0]?.contributionCount || 0,
        contributions: history.map(output),
        ...(query.contributionId
          ? {
              selectedContribution: await this.contributions
                .findOne(
                  { ...filter, _id: query.contributionId },
                  admin ? { requestHash: 0 } : publicFields,
                )
                .lean()
                .then((r) => (r ? output(r) : null)),
            }
          : {}),
      },
      pagination: { page: query.page, limit: query.limit, total: count },
    };
  }
  async create(kind, data, actorId, partnerId) {
    const model = kind === "partner" ? this.partners : this.contributions;
    const { requestId, ...input } = data;
    const id = hash([kind, actorId, partnerId, requestId]);
    const requestHash = hash(data);
    const existing = await model.findById(id).lean();
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictError("Mã yêu cầu đã được sử dụng cho dữ liệu khác.");
      if (existing.deletedAt)
        throw new ConflictError("Yêu cầu này đã được xử lý và xóa.");
      return this.result(existing);
    }
    if (partnerId) await this.partner(partnerId, true);
    const values = kind === "partner" ? input : this.normalize(input);
    await this.references(values);
    if (kind !== "partner" && input.sendNotification)
      await this.canNotify(partnerId, values);
    const prepared = [];
    try {
      await this.prepare(values, prepared);
      const row = await model.create({
        ...values,
        _id: id,
        ...(partnerId ? { partnerId } : {}),
        requestHash,
        createdBy: actorId,
        updatedBy: actorId,
        audit: [audit("create", actorId)],
        ...(kind !== "partner"
          ? {
              notification: {
                status: input.sendNotification ? "sent" : "none",
                ...(input.sendNotification
                  ? { sentAt: new Date(), error: "" }
                  : {}),
              },
            }
          : {}),
      });
      return this.result(row.toObject());
    } catch (e) {
      await Promise.all(prepared.map((p) => this.images.discard(p)));
      if (e.code === 11000) {
        const row = await model.findById(id).lean();
        if (row?.requestHash === requestHash) return this.result(row);
      }
      throw e;
    }
  }
  result(row) {
    const { requestHash, ...rest } = row;
    return { data: output(rest) };
  }
  normalize(input) {
    const value = contributionData.parse(input);
    if (value.type === "money")
      Object.assign(value, {
        itemName: "",
        quantity: null,
        estimatedValue: null,
      });
    else Object.assign(value, { amount: null, paymentMethod: null });
    delete value.sendNotification;
    return value;
  }
  async canNotify(partnerId, values) {
    const parent = await this.partner(partnerId, true);
    if (!parent.isPublished || !values.isPublished)
      throw new BadRequestError(
        "Chỉ gửi thông báo khi đơn vị và khoản tài trợ đều công khai.",
      );
  }
  async prepare(values, prepared) {
    if (values.logo !== undefined) {
      const p = await this.images.prepare(values.logo, "partners");
      prepared.push(p);
      values.logo = p.image;
    }
    if (values.images) {
      const paths = [];
      for (const image of values.images) {
        const p = await this.images.prepare(image, "partners");
        prepared.push(p);
        paths.push(p.image);
      }
      values.images = paths;
    }
  }
  async update(kind, id, input, actorId, remove = false) {
    const model = kind === "partner" ? this.partners : this.contributions;
    const current = await model.findOne({ _id: id, deletedAt: null }).lean();
    if (!current) throw new NotFoundError("Không tìm thấy dữ liệu.");
    if (kind !== "partner") await this.partner(current.partnerId, true);
    const values = remove
      ? { deletedAt: new Date(), isPublished: false }
      : kind === "partner"
        ? { ...input }
        : this.normalize({
            ...Object.fromEntries(
              Object.keys(contributionData.shape)
                .filter((k) => k in current)
                .map((k) => [k, current[k]]),
            ),
            ...input,
          });
    await this.references(values);
    const prepared = [];
    try {
      if (!remove) await this.prepare(values, prepared);
      const update = {
        $set: { ...values, updatedBy: actorId },
        $push: { audit: audit(remove ? "delete" : "update", actorId) },
      };
      if (input.sendNotification) {
        await this.canNotify(current.partnerId, values);
        if (current.notification?.status !== "sent")
          Object.assign(update.$set, {
            "notification.status": "sent",
            "notification.sentAt": new Date(),
            "notification.error": "",
          });
      }
      const row = await model
        .findOneAndUpdate(
          { _id: id, deletedAt: null, updatedAt: current.updatedAt },
          update,
          { new: true },
        )
        .lean();
      if (!row)
        throw new ConflictError("Dữ liệu vừa thay đổi. Vui lòng tải lại.");
      return this.result(row);
    } catch (e) {
      await Promise.all(prepared.map((p) => this.images.discard(p)));
      throw e;
    }
  }
  notificationPipeline() {
    return [
      {
        $match: {
          deletedAt: null,
          isPublished: true,
          "notification.status": "sent",
        },
      },
      {
        $lookup: {
          from: "partners",
          localField: "partnerId",
          foreignField: "_id",
          as: "partner",
        },
      },
      { $unwind: "$partner" },
      { $match: { "partner.deletedAt": null, "partner.isPublished": true } },
      {
        $project: {
          _id: 0,
          id: { $concat: ["partner-contribution-", "$_id"] },
          title: { $concat: ["Đồng hành: ", "$partner.name"] },
          description: "$title",
          paragraphs: ["$description"],
          category: { $literal: "Đơn vị đồng hành" },
          scope: { $literal: "public" },
          source: { $literal: "partners" },
          partnerId: 1,
          contributionId: "$_id",
          date: {
            $dateToString: {
              date: "$notification.sentAt",
              format: "%Y-%m-%d",
              timezone: "Asia/Ho_Chi_Minh",
            },
          },
          time: {
            $dateToString: {
              date: "$notification.sentAt",
              format: "%H:%M",
              timezone: "Asia/Ho_Chi_Minh",
            },
          },
          createdAt: "$notification.sentAt",
        },
      },
    ];
  }
}
