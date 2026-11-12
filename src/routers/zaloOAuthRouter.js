import { Router } from "express";
import { createRateLimiter } from "../middlewares/rateLimit.js";
import { presentMember } from "../services/memberService.js";
import { HttpError } from "../utils/httpError.js";

export const zaloSessionCookie = "tanson_zalo_session";
const flowCookie = "tanson_zalo_oauth";
export function readCookie(req, name) {
  const matches = (req.headers.cookie || "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : "";
}
const present = (data) => ({
  ...data,
  member: data.member ? presentMember(data.member) : null,
});

export default function zaloOAuthRouter(services) {
  const router = Router();
  router.use(createRateLimiter(20));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  const options = (path) => ({
    httpOnly: true,
    sameSite: "lax",
    path,
    secure: services.zaloOAuth.settings().redirect.protocol === "https:",
  });
  router.get("/login", async (req, res) => {
    const { url, browser } = await services.zaloOAuth.start();
    res.cookie(flowCookie, browser, {
      ...options("/api/v1/auth/zalo"),
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  });
  router.get("/callback", async (req, res) => {
    res.clearCookie(flowCookie, options("/api/v1/auth/zalo"));
    const { data, session, maxAge } = await services.zaloOAuth.callback(
      req.query,
      readCookie(req, flowCookie),
    );
    await services.zaloOAuth.logout(readCookie(req, zaloSessionCookie));
    res.cookie(zaloSessionCookie, session, { ...options("/api/v1"), maxAge });
    res.json({ data: present(data) });
  });
  router.get("/me", async (req, res) => {
    const token = await services.zaloOAuth.accessToken(
      readCookie(req, zaloSessionCookie),
    );
    const { zaloUserId, member } = await services.memberAccess.identity(token);
    res.json({
      data: present({ zaloUserId, linked: Boolean(member), member }),
    });
  });
  router.post("/logout", async (req, res) => {
    const origin = req.headers.origin;
    const allowed = [
      services.zaloOAuth.settings().redirect.origin,
      ...(services.zaloOAuth.config.get("CORS_ORIGINS") || "")
        .split(",")
        .map((v) => v.trim()),
    ];
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (origin && !allowed.includes(origin))
    )
      throw new HttpError(403, "Origin không hợp lệ.");
    await services.zaloOAuth.logout(readCookie(req, zaloSessionCookie));
    res.clearCookie(zaloSessionCookie, options("/api/v1"));
    res.json({ success: true });
  });
  return router;
}
