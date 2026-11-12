import { createHash } from "node:crypto";
import {
  BadRequestError,
  NotFoundError,
  ConflictError,
} from "../utils/httpError.js";

const statusText = {
  pending: "Đang chờ xét duyệt",
  approved: "Đã được duyệt",
  rejected: "Chưa được chấp thuận",
};
const notification = (row, kind) => {
  const reviewed = kind === "reviewed";
  const date = new Date(reviewed ? row.reviewedAt : row.createdAt);
  const title = reviewed
    ? `Hồ sơ hội viên: ${statusText[row.status]}`
    : "Đã tiếp nhận đăng ký hội viên";
  const description = reviewed
    ? row.status === "approved"
      ? "Hội đã duyệt hồ sơ đăng ký hội viên của bạn."
      : `Hội chưa chấp thuận hồ sơ.${row.rejectionReason ? " Lý do: " + row.rejectionReason : " Vui lòng liên hệ Ban thư ký."}`
    : "Hồ sơ đã được gửi đến Hội. Bạn sẽ nhận kết quả tại đây sau khi xét duyệt.";
  return {
    id: `registration-${row._id}-${kind}`,
    registrationId: row._id,
    title,
    description,
    category: "Đăng ký hội viên",
    date: date.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
    time: date.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      minute: "2-digit",
    }),
    createdAt: date.toISOString(),
    unread: true,
    paragraphs: [description],
    status: row.status,
  };
};

export class RegistrationNotificationService {
  constructor(registrations, members) {
    this.registrations = registrations;
    this.members = members;
  }
  async admin(query) {
    const filter = { deletedAt: null };
    const [rows, total, pendingCount] = await Promise.all([
      this.registrations
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.registrations.countDocuments(filter),
      this.registrations.countDocuments({ ...filter, status: "pending" }),
    ]);
    return {
      data: rows.map((row) => ({
        id: `registration-${row._id}-submitted`,
        registrationId: row._id,
        title: "Có hồ sơ đăng ký hội viên",
        description: `${row.fullName} — ${row.company}`,
        status: row.status,
        createdAt: row.createdAt,
        href: "/admin/registrations",
      })),
      pendingCount,
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async applicant(tokens) {
    if (!tokens.length) return { data: [], profiles: [] };
    const hashes = tokens.map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    const rows = await this.registrations
      .find({ notificationTokenHash: { $in: hashes }, deletedAt: null })
      .sort({ createdAt: -1, _id: 1 })
      .lean();
    const memberIds = rows
      .filter((row) => row.status === "approved" && row.memberId)
      .map((row) => row.memberId);
    const members = memberIds.length
      ? await this.members
          .find({ _id: { $in: memberIds }, deletedAt: null })
          .lean()
      : [];
    const fields = [
      "fullName",
      "avatar",
      "company",
      "phone",
      "email",
      "birthDate",
      "jobTitle",
      "companyAddress",
      "taxCode",
      "date",
      "status",
      "createdAt",
      "reviewedAt",
      "rejectionReason",
    ];
    const profiles = rows.map((row) => {
      const member = members.find(
        (item) =>
          item._id === row.memberId && item.sourceRegistrationId === row._id,
      );
      const memberFields = [
        "name",
        "avatar",
        "company",
        "phone",
        "email",
        "birthDate",
        "jobTitle",
        "companyAddress",
        "joinedAt",
        "position",
        "initials",
        "isBoard",
        "status",
        "updatedAt",
      ];
      return {
        id: row._id,
        ...Object.fromEntries(
          fields
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        ),
        member: member
          ? {
              id: member._id,
              ...Object.fromEntries(
                memberFields
                  .filter((key) => member[key] !== undefined)
                  .map((key) => [key, member[key]]),
              ),
            }
          : null,
      };
    });
    const data = rows
      .flatMap((row) => [
        notification(row, "submitted"),
        ...(["approved", "rejected"].includes(row.status) && row.reviewedAt
          ? [notification(row, "reviewed")]
          : []),
      ])
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    return { data, profiles };
  }
  async updateProfile(id, dto) {
    const { tokens, ...fields } = dto;
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
    if (fields.birthDate && fields.birthDate > today)
      throw new BadRequestError("Ngày sinh không được ở tương lai.");
    const tokenHashes = tokens.map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    await this.registrations.db.transaction(async (session) => {
      const row = await this.registrations
        .findOneAndUpdate(
          {
            _id: id,
            notificationTokenHash: { $in: tokenHashes },
            deletedAt: null,
          },
          { $set: fields },
          { new: true, runValidators: true, session },
        )
        .lean();
      if (!row)
        throw new NotFoundError(
          "Không tìm thấy hồ sơ hoặc mã theo dõi không hợp lệ.",
        );
      if (row.status === "approved") {
        const { fullName, taxCode, ...memberFields } = fields;
        const member = await this.members
          .findOneAndUpdate(
            {
              _id: row.memberId,
              sourceRegistrationId: row._id,
              deletedAt: null,
            },
            {
              $set: {
                ...memberFields,
                name: fullName,
                initials: fullName
                  .split(/\s+/)
                  .slice(-2)
                  .map((part) => part[0])
                  .join("")
                  .toLocaleUpperCase("vi"),
              },
            },
            { new: true, runValidators: true, session },
          )
          .lean();
        if (!member)
          throw new ConflictError(
            "Hồ sơ hội viên không còn khả dụng. Vui lòng liên hệ Hội.",
          );
      }
    });
    return this.applicant(tokens);
  }
  async syncAvatar(id, tokens, avatar) {
    const hashes = tokens.map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    await this.registrations.db.transaction(async (session) => {
      const row = await this.registrations
        .findOne({
          _id: id,
          notificationTokenHash: { $in: hashes },
          deletedAt: null,
        })
        .session(session)
        .lean();
      if (!row)
        throw new NotFoundError(
          "Không tìm thấy hồ sơ hoặc mã theo dõi không hợp lệ.",
        );
      // Never replace a portrait already chosen by the member/admin.
      if (!row.avatar)
        await this.registrations.updateOne(
          { _id: id, avatar: { $in: [null, ""] } },
          { $set: { avatar } },
          { session },
        );
      if (row.status === "approved")
        await this.members.updateOne(
          {
            _id: row.memberId,
            sourceRegistrationId: id,
            deletedAt: null,
            avatar: { $in: [null, ""] },
          },
          { $set: { avatar: row.avatar || avatar } },
          { session },
        );
    });
    return this.applicant(tokens);
  }
}
