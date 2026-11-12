import { NotFoundError, BadRequestError } from "../utils/httpError.js";
import { randomUUID } from "node:crypto";
export function presentMember(row) {
  const { _id, deletedAt, ...rest } = row;
  return { ...rest, id: _id };
}
export class MembersService {
  members;
  constructor(members) {
    this.members = members;
  }
  async list(query) {
    const filter = { deletedAt: null };
    if (query.status) filter.status = query.status;
    if (query.isBoard) filter.isBoard = query.isBoard === "true";
    if (query.search) {
      const escaped = Array.from(query.search, (c) =>
        "\\^$.*+?()[]{}|".includes(c) ? "\\" + c : c,
      ).join("");
      filter.$or = ["name", "company", "phone", "email"].map((key) => ({
        [key]: { $regex: escaped, $options: "i" },
      }));
    }
    const [rows, total] = await Promise.all([
      this.members
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.members.countDocuments(filter),
    ]);
    return {
      data: rows.map(presentMember),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async get(id) {
    const row = await this.members.findOne({ _id: id, deletedAt: null }).lean();
    if (!row) throw new NotFoundError("Không tìm thấy hội viên.");
    return presentMember(row);
  }
  fields(dto) {
    const { id, ...fields } = dto;
    if (
      fields.birthDate &&
      fields.birthDate > new Date().toISOString().slice(0, 10)
    )
      throw new BadRequestError("Ngày sinh không được ở tương lai.");
    return {
      ...fields,
      ...(fields.zaloUserId !== undefined
        ? { zaloUserId: fields.zaloUserId || null }
        : {}),
      initials: dto.name
        .split(/\s+/)
        .slice(-2)
        .map((w) => w[0])
        .join("")
        .toLocaleUpperCase("vi"),
    };
  }
  async create(dto) {
    const row = await this.members.create({
      ...this.fields(dto),
      _id: dto.id || randomUUID(),
    });
    return { data: presentMember(row.toObject()) };
  }
  async update(id, dto) {
    if (dto.id && dto.id !== id)
      throw new BadRequestError("Không thể đổi mã hội viên.");
    const row = await this.members
      .findOneAndUpdate(
        { _id: id, deletedAt: null },
        { $set: this.fields(dto) },
        { new: true, runValidators: true },
      )
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy hội viên.");
    return { data: presentMember(row) };
  }
  async remove(id) {
    const row = await this.members
      .findOneAndUpdate(
        { _id: id, deletedAt: null },
        { $set: { deletedAt: new Date(), status: "inactive" } },
      )
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy hội viên.");
    return { success: true };
  }
  async import(items) {
    let imported = 0;
    for (const dto of items) {
      if (!dto.id) throw new BadRequestError("Hồ sơ chuyển đổi cần có mã.");
      const result = await this.members.updateOne(
        { _id: dto.id },
        { $setOnInsert: { ...this.fields(dto), _id: dto.id } },
        { upsert: true, runValidators: true },
      );
      imported += result.upsertedCount;
    }
    return { data: { imported, skipped: items.length - imported } };
  }
}
