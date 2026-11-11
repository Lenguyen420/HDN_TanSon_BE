import { UnauthorizedError } from "../utils/httpError.js";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, tokenHash, verifyPassword } from "../utils/password.js";
export class AuthService {
  users;
  sessions;
  jwt;
  config;
  dummyHash;
  constructor(users, sessions, jwt, config) {
    this.users = users;
    this.sessions = sessions;
    this.jwt = jwt;
    this.config = config;
  }
  async initialize() {
    await Promise.all([this.users.init(), this.sessions.init()]);
    this.dummyHash = await hashPassword(randomBytes(32).toString("hex"));
    const username = this.config.get("ADMIN_USERNAME")?.trim().toLowerCase(),
      password = this.config.get("ADMIN_PASSWORD");
    if (!username || !password) return;
    if (password.length < 12)
      throw Error("ADMIN_PASSWORD cần ít nhất 12 ký tự.");
    await this.users.updateOne(
      { username },
      {
        $setOnInsert: {
          _id: randomUUID(),
          username,
          passwordHash: await hashPassword(password),
          name: this.config.get("ADMIN_NAME") || "Quản trị viên",
          role: "SUPER_ADMIN",
          active: true,
        },
      },
      { upsert: true },
    );
  }
  async login(username, password) {
    const user = await this.users
      .findOne({ username: username.trim().toLowerCase() })
      .select("+passwordHash")
      .lean();
    const valid = await verifyPassword(
      password,
      user?.passwordHash || this.dummyHash,
    );
    if (!user || !user.active || !valid)
      throw new UnauthorizedError("Tên đăng nhập hoặc mật khẩu không đúng.");
    if (
      !user.passwordHash.startsWith("$2") &&
      !user.passwordHash.startsWith("bcrypt-sha256:")
    ) {
      await this.users.updateOne(
        { _id: user._id, passwordHash: user.passwordHash },
        { $set: { passwordHash: await hashPassword(password) } },
      );
    }
    const refreshToken = randomBytes(48).toString("base64url");
    const session = await this.sessions.create({
      _id: randomUUID(),
      userId: user._id,
      tokenHash: tokenHash(refreshToken),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    });
    return this.tokens(user, session._id, refreshToken);
  }
  async tokens(user, sid, refreshToken) {
    const accessToken = await this.jwt.signAsync(
      { sub: user._id, sid },
      { expiresIn: 900, issuer: "tanson-backend", audience: "tanson-admin" },
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
    };
  }
  async refresh(refreshToken) {
    const next = randomBytes(48).toString("base64url");
    const session = await this.sessions
      .findOneAndUpdate(
        { tokenHash: tokenHash(refreshToken), expiresAt: { $gt: new Date() } },
        { $set: { tokenHash: tokenHash(next) } },
        { new: true },
      )
      .lean();
    if (!session) throw new UnauthorizedError("Phiên đăng nhập đã hết hạn.");
    const user = await this.users
      .findOne({ _id: session.userId, active: true })
      .lean();
    if (!user) {
      await this.sessions.deleteOne({ _id: session._id });
      throw new UnauthorizedError();
    }
    return this.tokens(user, session._id, next);
  }
  async logout(refreshToken) {
    await this.sessions.deleteOne({ tokenHash: tokenHash(refreshToken) });
    return { success: true, message: "Đã đăng xuất." };
  }
  async authenticate(token) {
    try {
      const payload = await this.jwt.verifyAsync(token, {
        issuer: "tanson-backend",
        audience: "tanson-admin",
        algorithms: ["HS256"],
      });
      const [user, session] = await Promise.all([
        this.users.findOne({ _id: payload.sub, active: true }).lean(),
        this.sessions
          .findOne({
            _id: payload.sid,
            userId: payload.sub,
            expiresAt: { $gt: new Date() },
          })
          .lean(),
      ]);
      if (!user || !session) throw Error();
      return {
        id: user._id,
        username: user.username,
        name: user.name,
        role: user.role,
      };
    } catch {
      throw new UnauthorizedError(
        "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
      );
    }
  }
}
