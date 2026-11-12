import { randomUUID, createHash } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
export const id = () => randomUUID();
export function fail(status, code, message) {
  const error = new HttpError(status, message);
  error.code = code;
  throw error;
}
export const staff = (actor) => ["SUPER_ADMIN", "STAFF"].includes(actor?.role);
export function seller(actor) {
  if (actor?.role !== "BUSINESS")
    fail(
      403,
      "BUSINESS_PROFILE_REQUIRED",
      "Chỉ hội viên doanh nghiệp được đăng tin giao thương.",
    );
  if (actor.status !== "ACTIVE")
    fail(403, "ACCOUNT_NOT_ACTIVE", "Hồ sơ hội viên chưa hoạt động.");
}
export function owns(actor, ownerId) {
  if (!actor || (!staff(actor) && actor.id !== ownerId))
    fail(
      403,
      "RESOURCE_FORBIDDEN",
      "Bạn không có quyền thực hiện thao tác này.",
    );
}
export function present(row) {
  if (!row) return null;
  const { _id, _lock, _useLock, tokenHash, ...rest } = row;
  return { ...rest, id: _id };
}
export const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function page(rows, total, query) {
  return {
    success: true,
    data: rows.map(present),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}
export const ok = (data) => ({ success: true, data });
export const expired = (post) => {
  const until = post.expiresAt ?? post.eventEndAt;
  return until && new Date(until) <= new Date();
};
export const publicExpiry = () => ({
  $or: [
    { expiresAt: { $gt: new Date() } },
    {
      expiresAt: null,
      $or: [{ eventEndAt: null }, { eventEndAt: { $gt: new Date() } }],
    },
  ],
});
export async function transaction(connection, action) {
  const session = await connection.startSession();
  try {
    return await session.withTransaction(() => action(session));
  } finally {
    await session.endSession();
  }
}
export const allowedPurposes = (type) =>
  type === "TEMPLE_MANAGEMENT" ? ["NON_PROFIT"] : ["COMMERCIAL", "NON_PROFIT"];
