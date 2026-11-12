import { id, fail, hash, staff } from "./tradeShared.js";
export class TradeAuthService {
  constructor(connection, models, jwt, services) {
    this.connection = connection;
    this.models = models;
    this.jwt = jwt;
    this.services = services;
    this.users = connection.db.collection("trade_users");
  }
  async initialize() {
    await this.users.createIndex({ source: 1, sourceId: 1 }, { unique: true });
  }
  async session(dto, zaloToken) {
    let source, sourceId, name, avatar, member;
    if (dto.tokens?.length) {
      const row = await this.models.registrations
        .findOne({
          notificationTokenHash: { $in: dto.tokens.map(hash) },
          deletedAt: null,
          ...(dto.registrationId ? { _id: dto.registrationId } : {}),
        })
        .sort({ status: 1, createdAt: -1 })
        .lean();
      if (!row)
        fail(
          401,
          "INVALID_RECEIPT",
          "Không xác thực được hồ sơ trên thiết bị này. Vui lòng đăng ký hội viên.",
        );
      source = "registration";
      sourceId = row._id;
      name = row.fullName;
      avatar = row.avatar;
      if (row.status === "approved" && row.memberId)
        member = await this.models.members
          .findOne({ _id: row.memberId, deletedAt: null })
          .lean();
    } else {
      const identity = await this.services.memberAccess.identity(
        zaloToken,
        true,
      );
      source = "zalo";
      sourceId = identity.zaloUserId;
      name =
        identity.profile?.name || identity.member?.name || "Người quan tâm";
      avatar = identity.profile?.picture?.data?.url;
      member = identity.member;
    }
    const now = new Date();
    const filter = { source, sourceId },
      changes = {
        displayName: name,
        avatarUrl: avatar || "",
        memberId: member?._id || null,
        updatedAt: now,
      };
    let user;
    try {
      user = await this.users.findOneAndUpdate(
        filter,
        {
          $set: changes,
          $setOnInsert: {
            _id: id(),
            source,
            sourceId,
            status: "ACTIVE",
            businessType: "GENERAL",
            createdAt: now,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      user = await this.users.findOneAndUpdate(
        filter,
        { $set: changes },
        { returnDocument: "after" },
      );
    }
    const actor = await this.actor(user);
    const accessToken = await this.jwt.signAsync(
      { sub: user._id },
      { expiresIn: 1800, issuer: "tanson-backend", audience: "tanson-trade" },
    );
    return { accessToken, expiresIn: 1800, user: actor };
  }
  async actor(user) {
    if (!user || user.status === "BLOCKED")
      fail(
        401,
        "ACCOUNT_BLOCKED",
        "Tài khoản giao thương không khả dụng. Vui lòng liên hệ Ban thư ký Hội.",
      );
    // Recheck the backing registration/member on every request; a saved SDK ID
    // or a revoked receipt must never continue granting publishing rights.
    let member = null;
    if (user.source === "registration") {
      const registration = await this.models.registrations
        .findOne({ _id: user.sourceId, deletedAt: null })
        .lean();
      if (!registration)
        fail(401, "INVALID_RECEIPT", "Hồ sơ đăng ký không còn hiệu lực.");
      if (registration.status === "approved" && registration.memberId)
        member = await this.models.members
          .findOne({ _id: registration.memberId, deletedAt: null })
          .lean();
    } else
      member = await this.models.members
        .findOne({ zaloUserId: user.sourceId, deletedAt: null })
        .lean();
    return {
      id: user._id,
      role: member ? "BUSINESS" : "USER",
      status: member
        ? member.status === "active"
          ? "ACTIVE"
          : "PENDING"
        : user.status,
      businessType: user.businessType || "GENERAL",
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      company: member?.company || "",
      memberId: member?._id || null,
    };
  }
  async authenticate(token, optional = false) {
    if (!token && optional) return null;
    let payload;
    try {
      payload = await this.jwt.verifyAsync(token, {
        issuer: "tanson-backend",
        audience: "tanson-trade",
      });
    } catch {
      fail(
        401,
        "UNAUTHENTICATED",
        "Vui lòng xác thực hồ sơ để sử dụng Giao thương.",
      );
    }
    return this.actor(await this.users.findOne({ _id: payload.sub }));
  }
  async owner(ownerId) {
    const user = await this.users.findOne({ _id: ownerId });
    if (!user)
      fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy doanh nghiệp đăng tin.");
    return this.actor(user);
  }
  async adminAccount(actor, userId, changes) {
    if (actor.role !== "SUPER_ADMIN")
      fail(
        403,
        "ADMIN_REQUIRED",
        "Chỉ quản trị viên cấp cao được quản lý tài khoản.",
      );
    const row = await this.users.findOneAndUpdate(
      { _id: userId },
      { $set: { ...changes, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!row) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tài khoản.");
    const { sourceId, ...safe } = row;
    return safe;
  }
}
