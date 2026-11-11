import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
export function loadEnvironment() {
  dotenv.config({
    path: fileURLToPath(new URL("../../.env", import.meta.url)),
    quiet: true,
  });
  if (!process.env.MONGODB_URI?.startsWith("mongodb"))
    throw new Error("Điền MONGODB_URI trong .env trước khi chạy.");
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    throw new Error("JWT_SECRET cần ít nhất 32 ký tự.");
  const port = Number(process.env.PORT || 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT không hợp lệ.");
  return { get: (key) => process.env[key] };
}
