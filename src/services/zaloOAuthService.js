import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import { HttpError, UnauthorizedError } from "../utils/httpError.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const opaqueToken = () => randomBytes(32).toString("base64url");
const validToken = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export class ZaloOAuthService {
  constructor(models, config, memberAccess, transport = fetch) {
    this.models = models;
    this.config = config;
    this.memberAccess = memberAccess;
    this.transport = transport;
  }

  settings() {
    const appId = this.config.get("ZALO_APP_ID");
    const secret = this.config.get("ZALO_APP_SECRET");
    let redirect;
    try {
      redirect = new URL(this.config.get("ZALO_REDIRECT_URI"));
    } catch {
      throw new HttpError(503, "Chưa cấu hình ZALO_REDIRECT_URI hợp lệ.");
    }
    if (
      !/^\d+$/.test(appId || "") ||
      !secret ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      redirect.pathname !== "/api/v1/auth/zalo/callback" ||
      (redirect.protocol !== "https:" &&
        !(
          this.config.get("NODE_ENV") !== "production" &&
          this.config.get("VERCEL") !== "1" &&
          redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(redirect.hostname)
        ))
    )
      throw new HttpError(503, "Kiểm tra cấu hình OAuth Zalo trên backend.");
    return { appId, secret, redirect };
  }

  key() {
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.config.get("JWT_SECRET"),
        "tanson-zalo-oauth",
        "provider-token-encryption-v1",
        32,
      ),
    );
  }

  encrypt(token) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }

  decrypt(value) {
    try {
      const bytes = Buffer.from(value, "base64url");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      throw new UnauthorizedError(
        "Phiên Zalo đã hết hạn. Vui lòng đăng nhập lại.",
      );
    }
  }

  async start() {
    const { appId, redirect } = this.settings();
    const verifier = opaqueToken(),
      state = opaqueToken(),
      browser = opaqueToken();
    await this.models.flows.create({
      _id: hash(state),
      browserHash: hash(browser),
      verifier,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = new URL("https://oauth.zaloapp.com/v4/permission");
    url.searchParams.set("app_id", appId);
    url.searchParams.set("redirect_uri", redirect.href);
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    url.searchParams.set("state", state);
    return { url: url.href, browser };
  }

  async callback(query, browser) {
    const { appId, secret } = this.settings();
    if (!validToken(query.state) || !validToken(browser))
      throw new UnauthorizedError("State hoặc phiên OAuth Zalo không hợp lệ.");
    // Atomically consume state; expiry is checked even before MongoDB's TTL cleanup.
    const flow = await this.models.flows
      .findOneAndDelete({
        _id: hash(query.state),
        browserHash: hash(browser),
        expiresAt: { $gt: new Date() },
      })
      .lean();
    if (!flow)
      throw new UnauthorizedError(
        "Phiên OAuth Zalo đã hết hạn hoặc đã sử dụng.",
      );
    if (
      query.error ||
      typeof query.code !== "string" ||
      !query.code ||
      query.code.length > 4096
    )
      throw new UnauthorizedError(
        "Zalo chưa cấp quyền đăng nhập. Vui lòng thử lại.",
      );
    let response, payload;
    try {
      response = await this.transport(
        "https://oauth.zaloapp.com/v4/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            secret_key: secret,
          },
          body: new URLSearchParams({
            code: query.code,
            app_id: appId,
            grant_type: "authorization_code",
            code_verifier: flow.verifier,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      payload = await response.json();
    } catch {
      throw new HttpError(
        503,
        "Chưa thể đổi mã đăng nhập với Zalo. Vui lòng thử lại.",
      );
    }
    if (
      !response.ok ||
      payload?.error ||
      typeof payload?.access_token !== "string" ||
      !payload.access_token ||
      payload.access_token.length > 4096
    )
      throw new UnauthorizedError(
        "Mã đăng nhập Zalo không hợp lệ hoặc đã hết hạn.",
      );
    const providerLifetime = Number(payload.expires_in);
    if (!Number.isFinite(providerLifetime) || providerLifetime <= 0)
      throw new UnauthorizedError("Thời hạn phiên Zalo không hợp lệ.");
    const maxAge = Math.min(providerLifetime, 15 * 60) * 1000;
    const data = await this.memberAccess.session(payload.access_token);
    const session = opaqueToken();
    await this.models.sessions.create({
      _id: hash(session),
      encryptedToken: this.encrypt(payload.access_token),
      expiresAt: new Date(Date.now() + maxAge),
    });
    return { data, session, maxAge };
  }

  async accessToken(session) {
    if (!validToken(session)) throw new UnauthorizedError();
    const record = await this.models.sessions
      .findOne({ _id: hash(session), expiresAt: { $gt: new Date() } })
      .lean();
    if (!record) throw new UnauthorizedError();
    return this.decrypt(record.encryptedToken);
  }

  async logout(session) {
    if (validToken(session))
      await this.models.sessions.deleteOne({ _id: hash(session) });
  }
}
