import { HttpError } from "../utils/httpError.js";
import { ZodError } from "zod";
export default function errorMiddleware(error, req, res, next) {
  if (res.headersSent) return next(error);
  const duplicate = error?.code === 11000;
  const status = duplicate
    ? 409
    : error instanceof HttpError
      ? error.status
      : error instanceof ZodError
        ? 400
        : error?.type === "entity.parse.failed"
          ? 400
          : error?.type === "entity.too.large"
            ? 413
            : 500;
  const message = duplicate
    ? "Dữ liệu bị trùng."
    : error instanceof ZodError
      ? error.issues.map((issue) => issue.path.join(".") + ": " + issue.message)
      : error instanceof HttpError
        ? error.message
        : status === 400
          ? "Dữ liệu JSON không hợp lệ."
          : status === 413
            ? "Dữ liệu gửi lên quá lớn."
            : "Có lỗi máy chủ. Vui lòng thử lại.";
  if (status === 500)
    console.error("[API] Internal error:", error?.name || "Error");
  res.status(status).json({ statusCode: status, message });
}
