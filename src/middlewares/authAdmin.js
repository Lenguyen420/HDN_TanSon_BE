import { HttpError } from "../utils/httpError.js";
export default function authAdmin(auth) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    req.user = await auth.authenticate(
      header.startsWith("Bearer ") ? header.slice(7) : "",
    );
    if (!["SUPER_ADMIN", "STAFF"].includes(req.user.role))
      throw new HttpError(403, "Bạn không có quyền truy cập.");
    next();
  };
}
