import { scrypt as rawScrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcrypt";
const scrypt = promisify(rawScrypt);
const prehash = (password) =>
  createHash("sha256").update(password).digest("base64");
export async function hashPassword(password) {
  // bcrypt consumes at most 72 bytes. Prehash longer legacy passwords so their suffix remains significant.
  if (Buffer.byteLength(password, "utf8") > 72)
    return "bcrypt-sha256:" + (await bcrypt.hash(prehash(password), 12));
  return bcrypt.hash(password, 12);
}
export async function verifyPassword(password, stored) {
  if (stored.startsWith("bcrypt-sha256:"))
    return bcrypt.compare(
      prehash(password),
      stored.slice("bcrypt-sha256:".length),
    );
  if (stored.startsWith("$2")) return bcrypt.compare(password, stored);
  // Existing accounts used scrypt; keep them usable during the migration.
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const key = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const tokenHash = (value) =>
  createHash("sha256").update(value).digest("hex");
