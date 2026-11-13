import { NotFoundError, BadRequestError } from "../utils/httpError.js";
import { randomUUID } from "node:crypto";
import { BusinessLicenseStorage } from "./businessLicenseStorage.js";
export function presentMember(row) {
  const {
    _id,
    deletedAt,
    businessLicenseFileId,
    businessLicenseOwnerId,
    ...rest
  } = row;
  return { ...rest, id: _id, hasBusinessLicense: !!businessLicenseFileId };
}
export class MembersService {
  members;
  constructor(members, imageStorage) {
    this.members = members;
    this.imageStorage = imageStorage;
    this.businessLicenses = new BusinessLicenseStorage(members.db.db);
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
        .select("+businessLicenseFileId +businessLicenseOwnerId")
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
    const row = await this.members
      .findOne({ _id: id, deletedAt: null })
      .select("+businessLicenseFileId +businessLicenseOwnerId")
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy hội viên.");
    return presentMember(row);
  }
  fields(dto) {
    const { id, businessLicenseImage, ...fields } = dto;
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
    return this.saveWithAssets(dto.id || randomUUID(), dto);
  }
  async update(id, dto) {
    if (dto.id && dto.id !== id)
      throw new BadRequestError("Không thể đổi mã hội viên.");
    const current = await this.members
      .findOne({ _id: id, deletedAt: null })
      .lean();
    if (!current) throw new NotFoundError("Không tìm thấy hội viên.");
    return this.saveWithAssets(id, dto, current);
  }
  async saveWithAssets(id, dto, current = null) {
    const fields = this.fields(dto);
    const avatar =
      current && dto.avatar === current.avatar
        ? {}
        : await this.imageStorage.prepare(dto.avatar, "members");
    let fileId;
    try {
      if (dto.avatar !== undefined && avatar.image !== undefined)
        fields.avatar = avatar.image;
      if (dto.businessLicenseImage) {
        fileId = await this.businessLicenses.save(
          `member:${id}`,
          dto.businessLicenseImage,
        );
        fields.businessLicenseFileId = fileId;
        fields.businessLicenseOwnerId = `member:${id}`;
      }
      const row = current
        ? await this.members
            .findOneAndUpdate(
              { _id: id, deletedAt: null },
              { $set: fields },
              { new: true, runValidators: true },
            )
            .select("+businessLicenseFileId +businessLicenseOwnerId")
            .lean()
        : (await this.members.create({ ...fields, _id: id })).toObject();
      if (!row) throw new NotFoundError("Không tìm thấy hội viên.");
      return { data: presentMember(row) };
    } catch (error) {
      await this.imageStorage.discard(avatar);
      if (fileId) await this.businessLicenses.discard(fileId);
      throw error;
    }
  }
  async businessLicense(id, req, res) {
    const member = await this.members
      .findOne({ _id: id, deletedAt: null })
      .select("+businessLicenseFileId +businessLicenseOwnerId")
      .lean();
    if (!member?.businessLicenseFileId)
      throw new NotFoundError("Hội viên chưa có ảnh giấy phép kinh doanh.");
    await this.businessLicenses.serve(
      member.businessLicenseFileId,
      member.businessLicenseOwnerId || member.sourceRegistrationId,
      req,
      res,
    );
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
