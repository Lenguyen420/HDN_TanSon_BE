import { createHash } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
const options = {
  issuer: "tanson-backend",
  audience: "tanson-membership-fees",
};
const hash = (token) => createHash("sha256").update(token).digest("hex");
export class MembershipFeeAuthService {
  constructor(registrations, members, jwt) {
    Object.assign(this, { registrations, members, jwt });
  }
  async activeMember(registration) {
    if (registration?.status !== "approved" || !registration.memberId)
      throw new HttpError(
        403,
        "Hồ sơ chưa được duyệt thành hội viên. Vui lòng kiểm tra kết quả đăng ký hoặc liên hệ Ban thư ký.",
      );
    const member = await this.members
      .findOne({
        _id: registration.memberId,
        status: "active",
        deletedAt: null,
      })
      .lean();
    if (!member)
      throw new HttpError(
        403,
        "Hồ sơ hội viên không còn hoạt động. Vui lòng liên hệ Ban thư ký.",
      );
    return member;
  }
  async session(tokens) {
    const registrations = await this.registrations
      .find({
        notificationTokenHash: { $in: tokens.map(hash) },
        deletedAt: null,
      })
      .select("+notificationTokenHash")
      .sort({ createdAt: -1, _id: 1 })
      .lean();
    if (!registrations.length)
      throw new HttpError(
        401,
        "Mã hồ sơ trên thiết bị này không còn hợp lệ. Vui lòng liên hệ Ban thư ký.",
      );
    // A device may hold several receipts. Select an approved, active membership,
    // never an unrelated pending application or an ID claimed by the client.
    for (const registration of registrations) {
      if (registration.status !== "approved" || !registration.memberId)
        continue;
      const member = await this.members
        .findOne({
          _id: registration.memberId,
          status: "active",
          deletedAt: null,
        })
        .lean();
      if (!member) continue;
      const accessToken = await this.jwt.signAsync(
        {
          sub: registration._id,
          receiptHash: registration.notificationTokenHash,
        },
        { ...options, expiresIn: 1800 },
      );
      return {
        accessToken,
        expiresIn: 1800,
        member: { id: member._id, name: member.name },
      };
    }
    throw new HttpError(
      403,
      "Chưa có hồ sơ được duyệt gắn với hội viên đang hoạt động trên thiết bị này. Vui lòng kiểm tra kết quả đăng ký hoặc liên hệ Ban thư ký.",
    );
  }
  async authenticate(token) {
    let payload;
    try {
      payload = await this.jwt.verifyAsync(token, options);
      if (
        typeof payload.sub !== "string" ||
        typeof payload.receiptHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(payload.receiptHash)
      )
        throw Error("Invalid fee session");
    } catch {
      throw new HttpError(
        401,
        "Phiên hội phí đã hết hạn hoặc không hợp lệ. Vui lòng xác thực lại hồ sơ.",
      );
    }
    // Binding the JWT to the stored receipt hash also revokes existing sessions
    // when a receipt is rotated, its registration is deleted or approval revoked.
    const registration = await this.registrations
      .findOne({
        _id: payload.sub,
        notificationTokenHash: payload.receiptHash,
        deletedAt: null,
      })
      .lean();
    if (!registration)
      throw new HttpError(
        401,
        "Mã hồ sơ không còn hiệu lực. Vui lòng liên hệ Ban thư ký.",
      );
    return this.activeMember(registration);
  }
}
