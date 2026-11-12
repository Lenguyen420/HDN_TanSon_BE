import { HttpError, UnauthorizedError } from "../utils/httpError.js";

const directoryFields = [
  "name",
  "company",
  "jobTitle",
  "isBoard",
  "position",
  "initials",
];
export class MemberAccessService {
  constructor(members, config, users, transport = fetch) {
    this.members = members;
    this.config = config;
    this.users = users;
    this.transport = transport;
  }
  async identity(token, withProfile = false) {
    if (!token || token.length > 4096)
      throw new UnauthorizedError("Vui lòng xác thực bằng tài khoản Zalo.");
    let response, profile;
    try {
      response = await this.transport(
        withProfile
          ? "https://graph.zalo.me/v2.0/me?fields=id,name,picture"
          : "https://graph.zalo.me/v2.0/me?fields=id",
        {
          headers: { access_token: token },
          signal: AbortSignal.timeout(10000),
        },
      );
      profile = await response.json();
    } catch {
      throw new HttpError(503, "Chưa thể xác thực với Zalo. Vui lòng thử lại.");
    }
    if (
      !response.ok ||
      profile.error ||
      typeof profile.id !== "string" ||
      !/^\d{1,100}$/.test(profile.id)
    ) {
      throw new UnauthorizedError(
        "Phiên Zalo không hợp lệ hoặc đã hết hạn. Vui lòng xác thực lại.",
      );
    }
    // Chỉ tin ID từ máy chủ Zalo, không nhận ID/phone/name do client tự khai báo.
    const member = await this.members
      .findOne({ zaloUserId: profile.id, status: "active", deletedAt: null })
      .lean();
    return { zaloUserId: profile.id, member, profile };
  }
  async session(token, phoneToken) {
    const identity = await this.identity(token, true);
    const { profile, zaloUserId } = identity;
    if (typeof profile.name !== "string" || !profile.name.trim())
      throw new HttpError(
        403,
        "Vui lòng cho phép truy cập tên và ảnh đại diện Zalo.",
      );
    let phone = null;
    let phoneNotice = "";
    if (phoneToken) {
      const secret = this.config.get("ZALO_APP_SECRET");
      if (!secret) {
        phoneNotice =
          "Đã lưu tên và ảnh đại diện. Hệ thống chưa cấu hình xác minh số điện thoại Zalo.";
      } else {
        let response, payload;
        try {
          response = await this.transport(
            "https://graph.zalo.me/v2.0/me/info",
            {
              headers: {
                access_token: token,
                code: phoneToken,
                secret_key: secret,
              },
              signal: AbortSignal.timeout(10000),
            },
          );
          payload = await response.json();
        } catch {
          throw new HttpError(
            503,
            "Chưa thể xác minh số điện thoại với Zalo. Vui lòng thử lại.",
          );
        }
        if (
          !response.ok ||
          payload.error ||
          typeof payload.data?.number !== "string"
        )
          throw new HttpError(
            400,
            "Không xác minh được số điện thoại Zalo. Vui lòng cấp quyền lại.",
          );
        phone = payload.data.number.replace(/[^0-9]/g, "");
        if (phone.startsWith("84")) phone = "0" + phone.slice(2);
        if (!/^0[0-9]{9}$/.test(phone))
          throw new HttpError(400, "Số điện thoại Zalo trả về không hợp lệ.");
      }
    }
    const now = new Date();
    const avatar = profile.picture?.data?.url;
    const values = {
      name: profile.name.trim().slice(0, 150),
      avatar:
        typeof avatar === "string" && /^https:\/\//.test(avatar) ? avatar : "",
      profileConsentAt: now,
      lastLoginAt: now,
      ...(phone ? { phone, phoneConsentAt: now } : {}),
    };
    let user;
    try {
      user = await this.users
        .findOneAndUpdate(
          { _id: zaloUserId },
          { $set: values },
          { upsert: true, new: true, runValidators: true },
        )
        .lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      user = await this.users
        .findOneAndUpdate(
          { _id: zaloUserId },
          { $set: values },
          { new: true, runValidators: true },
        )
        .lean();
    }
    let member = identity.member;
    // Chỉ tự liên kết bằng số đã được Zalo xác minh, không tin số điện thoại client gửi.
    if (!member && phone) {
      const separator = "[\\s().-]*";
      const pattern =
        "^\\s*(?:\\+?84|0)" +
        separator +
        phone.slice(1).split("").join(separator) +
        "\\s*$";
      const matches = await this.members
        .find({ status: "active", deletedAt: null, phone: { $regex: pattern } })
        .limit(2)
        .lean();
      if (
        matches.length === 1 &&
        (!matches[0].zaloUserId || matches[0].zaloUserId === zaloUserId)
      ) {
        try {
          member = await this.members
            .findOneAndUpdate(
              {
                _id: matches[0]._id,
                status: "active",
                deletedAt: null,
                $or: [{ zaloUserId: null }, { zaloUserId }],
              },
              { $set: { zaloUserId } },
              { new: true },
            )
            .lean();
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
    }
    return {
      zaloUserId,
      phoneNotice,
      linked: Boolean(member),
      member,
      user: {
        id: user._id,
        name: user.name,
        avatar: user.avatar,
        phone: user.phone || null,
      },
    };
  }
  async directory(query) {
    const filter = { deletedAt: null, status: "active" };
    if (query.isBoard) filter.isBoard = query.isBoard === "true";
    if (query.search) {
      const escaped = Array.from(query.search, (character) =>
        "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character,
      ).join("");
      filter.$or = ["name", "company"].map((key) => ({
        [key]: { $regex: escaped, $options: "i" },
      }));
    }
    const [rows, total] = await Promise.all([
      this.members
        .find(filter)
        .select(directoryFields.join(" "))
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.members.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) =>
        Object.fromEntries([
          ["id", row._id],
          ...directoryFields
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        ]),
      ),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
}
