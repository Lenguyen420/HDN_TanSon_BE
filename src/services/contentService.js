import { randomUUID } from "node:crypto";
import { BadRequestError, NotFoundError } from "../utils/httpError.js";

function present(row) {
  const { _id, deletedAt, ...fields } = row;
  return { ...fields, id: _id };
}

export class ContentService {
  constructor(model, definition, imageStorage, collection) {
    this.model = model;
    this.definition = definition;
    this.imageStorage = imageStorage;
    this.collection = collection;
  }

  publicFilter() {
    if (!this.definition.dateField) return { status: "active" };
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(now);
    const filter = {
      status: "published",
      [this.definition.dateField]: { $lte: today },
    };
    if (this.definition.dateField === "date") {
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(now);
      filter.$or = [{ date: { $lt: today } }, { time: { $lte: time } }];
    }
    return filter;
  }

  async list(query, isPublic = false) {
    const filter = { deletedAt: null };
    for (const key of this.definition.filters)
      if (query[key] !== undefined) filter[key] = query[key];
    if (isPublic) Object.assign(filter, this.publicFilter());
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$and = [
        {
          $or: this.definition.search.map((key) => ({
            [key]: { $regex: escaped, $options: "i" },
          })),
        },
      ];
    }
    const [rows, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(this.definition.sort)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.model.countDocuments(filter),
    ]);
    return {
      data: rows.map(present),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }

  async get(id, isPublic = false) {
    const row = await this.model
      .findOne({
        _id: id,
        deletedAt: null,
        ...(isPublic ? this.publicFilter() : {}),
      })
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy nội dung.");
    return present(row);
  }

  async create(dto) {
    const { id, ...fields } = dto;
    const prepared = await this.imageStorage.prepare(
      fields.image,
      this.collection,
    );
    if (fields.image !== undefined) fields.image = prepared.image;
    try {
      const row = await this.model.create({
        ...fields,
        _id: id || randomUUID(),
      });
      return { data: present(row.toObject()) };
    } catch (error) {
      await this.imageStorage.discard(prepared);
      throw error;
    }
  }

  async update(id, dto) {
    if (dto.id && dto.id !== id)
      throw new BadRequestError("Không thể đổi mã nội dung.");
    const { id: ignored, ...fields } = dto;
    // Update event fields individually so older admin forms preserve documents/minutes.
    if (this.collection === "events" && fields.event) {
      for (const [key, value] of Object.entries(fields.event))
        fields["event." + key] = value;
      delete fields.event;
    }
    // Avoid writing a new file for a missing/deleted record.
    const current = await this.model
      .findOne({ _id: id, deletedAt: null })
      .select("image")
      .lean();
    if (!current) throw new NotFoundError("Không tìm thấy nội dung.");
    // Metadata edits keep the existing reference even if legacy storage is
    // unavailable. Only a changed image needs upload validation/preparation.
    const unchangedImage = fields.image === current.image;
    const prepared = unchangedImage
      ? {}
      : await this.imageStorage.prepare(fields.image, this.collection);
    if (unchangedImage) delete fields.image;
    else if (fields.image !== undefined) fields.image = prepared.image;
    try {
      const row = await this.model
        .findOneAndUpdate(
          { _id: id, deletedAt: null },
          { $set: fields },
          { new: true, runValidators: true },
        )
        .lean();
      if (!row) throw new NotFoundError("Không tìm thấy nội dung.");
      return { data: present(row) };
    } catch (error) {
      await this.imageStorage.discard(prepared);
      throw error;
    }
  }

  async remove(id) {
    const row = await this.model
      .findOneAndUpdate(
        { _id: id, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      )
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy nội dung.");
    return { success: true };
  }
}
