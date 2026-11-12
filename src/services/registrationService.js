import {
  ConflictError,
  NotFoundError,
  BadRequestError,
  HttpError,
} from "../utils/httpError.js";
import { randomUUID, createHash } from "node:crypto";
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
const present = (row) => {
  const { _id, deletedAt, notificationTokenHash, ...rest } = row;
  return { ...rest, id: _id };
};
export class RegistrationService {
  registrations;
  members;
  connection;
  constructor(registrations, members, connection) {
    this.registrations = registrations;
    this.members = members;
    this.connection = connection;
  }
  async initialize() {
    await Promise.all([this.registrations.init(), this.members.init()]);
  }
  validateBirthDate(dto) {
    if (dto.birthDate && dto.birthDate > today())
      throw new BadRequestError("Ngày sinh không được ở tương lai.");
  }
  async list(query) {
    const filter = { deletedAt: null };
    if (query.status) filter.status = query.status;
    if (query.search) {
      const escaped = Array.from(query.search, (c) =>
        "\\^$.*+?()[]{}|".includes(c) ? "\\" + c : c,
      ).join("");
      filter.$or = ["fullName", "company", "phone", "email", "taxCode"].map(
        (key) => ({ [key]: { $regex: escaped, $options: "i" } }),
      );
    }
    const [rows, total] = await Promise.all([
      this.registrations
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.registrations.countDocuments(filter),
    ]);
    return {
      data: rows.map(present),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async get(id) {
    const row = await this.registrations
      .findOne({ _id: id, deletedAt: null })
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy hồ sơ.");
    return { data: present(row) };
  }
  async create(dto) {
    this.validateBirthDate(dto);
    const { id, ...fields } = dto;
    const row = await this.registrations.create({
      ...fields,
      _id: id || randomUUID(),
      status: "pending",
    });
    return { data: present(row.toObject()) };
  }
  async submitPublic(dto) {
    const { notificationToken, ...fields } = dto;
    const result = await this.create({
      ...fields,
      date: today(),
      ...(notificationToken
        ? {
            notificationTokenHash: createHash("sha256")
              .update(notificationToken)
              .digest("hex"),
          }
        : {}),
    });
    return {
      data: { id: result.data.id, status: result.data.status },
      message: "Đã tiếp nhận hồ sơ. Vui lòng chờ Hội xét duyệt.",
    };
  }
  async update(id, dto) {
    this.validateBirthDate(dto);
    if (dto.id && dto.id !== id)
      throw new BadRequestError("Không thể đổi mã hồ sơ.");
    const { id: ignored, ...fields } = dto;
    const row = await this.registrations
      .findOneAndUpdate(
        { _id: id, status: "pending", deletedAt: null },
        { $set: fields },
        { new: true, runValidators: true },
      )
      .lean();
    if (!row) throw new ConflictError("Chỉ được sửa hồ sơ đang chờ duyệt.");
    return { data: present(row) };
  }
  async remove(id) {
    const row = await this.registrations
      .findOneAndUpdate(
        { _id: id, status: { $ne: "approved" }, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { new: true },
      )
      .lean();
    if (!row)
      throw new ConflictError(
        "Không thể xóa hồ sơ đã duyệt hoặc không còn tồn tại.",
      );
    return { success: true };
  }
  async approve(id, reviewerId) {
    const memberId = randomUUID();
    return this.connection.transaction(async (session) => {
      const registration = await this.registrations
        .findOneAndUpdate(
          { _id: id, status: "pending", deletedAt: null },
          {
            $set: {
              status: "approved",
              memberId,
              reviewedBy: reviewerId,
              reviewedAt: new Date(),
            },
          },
          { new: true, session },
        )
        .lean();
      if (!registration)
        throw new ConflictError("Hồ sơ đã được xử lý hoặc không còn tồn tại.");
      const [member] = await this.members.create(
        [
          {
            _id: memberId,
            sourceRegistrationId: id,
            name: registration.fullName,
            avatar: registration.avatar || "",
            company: registration.company,
            phone: registration.phone,
            email: registration.email,
            birthDate: registration.birthDate,
            jobTitle: registration.jobTitle,
            companyAddress: registration.companyAddress,
            joinedAt: today(),
            position: "Hội viên",
            isBoard: false,
            status: "active",
            initials: registration.fullName
              .split(/\s+/)
              .slice(-2)
              .map((w) => w[0])
              .join("")
              .toLocaleUpperCase("vi"),
          },
        ],
        { session },
      );
      return {
        data: { registration: present(registration), memberId: member._id },
      };
    });
  }
  async reject(id, reviewerId, reason) {
    const row = await this.registrations
      .findOneAndUpdate(
        { _id: id, status: "pending", deletedAt: null },
        {
          $set: {
            status: "rejected",
            reviewedBy: reviewerId,
            reviewedAt: new Date(),
            rejectionReason: reason || "",
          },
        },
        { new: true, runValidators: true },
      )
      .lean();
    if (!row)
      throw new ConflictError("Hồ sơ đã được xử lý hoặc không còn tồn tại.");
    return { data: present(row) };
  }
  async import(items, actorId) {
    let imported = 0,
      skipped = 0;
    const failed = [];
    for (const dto of items) {
      try {
        if (!dto.id) throw new BadRequestError("Hồ sơ chuyển đổi cần có mã.");
        this.validateBirthDate(dto);
        const result = await this.connection.transaction(async (session) => {
          if (await this.registrations.exists({ _id: dto.id }).session(session))
            return false;
          const { id, status = "pending", memberId, ...fields } = dto;
          if (
            status === "approved" &&
            (!memberId ||
              !(await this.members.exists({ _id: memberId }).session(session)))
          )
            throw new ConflictError(
              "Chuyển hội viên tương ứng lên MongoDB trước khi chuyển hồ sơ đã duyệt.",
            );
          await this.registrations.create(
            [
              {
                ...fields,
                _id: id,
                status,
                importedBy: actorId,
                ...(status === "approved" ? { memberId } : {}),
              },
            ],
            { session },
          );
          return true;
        });
        if (result) imported++;
        else skipped++;
      } catch (error) {
        failed.push({
          id: dto.id || "",
          message:
            error instanceof HttpError
              ? error.message
              : "Không chuyển được hồ sơ. Vui lòng thử lại.",
        });
      }
    }
    return { data: { imported, skipped, failed } };
  }
}
