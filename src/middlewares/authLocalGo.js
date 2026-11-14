import authAdmin from "./authAdmin.js";
import { HttpError } from "../utils/httpError.js";
import { readCookie, zaloSessionCookie } from "../routers/zaloOAuthRouter.js";

export default function authLocalGo(services) {
  const admin = authAdmin(services.auth);
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    let token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      const cookie = readCookie(req, zaloSessionCookie);
      if (cookie) token = await services.zaloOAuth.accessToken(cookie);
    }
    if (!token) throw new HttpError(401, "Vui lòng đăng nhập.");
    if (token.split(".").length === 3) {
      try {
        return await admin(req, res, () => {
          res.locals.localgoActor = req.user;
          next();
        });
      } catch (error) {
        if (error.status !== 401) throw error;
      }
      res.locals.localgoActor = await services.tradeAuth.authenticate(token);
    } else {
      const identity = await services.memberAccess.identity(token);
      res.locals.localgoActor = {
        id: identity.zaloUserId,
        memberId: identity.member?._id,
        status: identity.member ? "ACTIVE" : "PENDING",
      };
    }
    const actor = res.locals.localgoActor;
    if (!actor.memberId || actor.status !== "ACTIVE")
      throw new HttpError(
        403,
        "Chỉ hội viên đang hoạt động được quản lý địa điểm.",
      );
    next();
  };
}
