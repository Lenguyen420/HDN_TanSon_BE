import { createHash } from "node:crypto";

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
}
