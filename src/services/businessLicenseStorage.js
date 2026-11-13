import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError } from "../utils/httpError.js";

export const businessLicensePattern =
  /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
export class BusinessLicenseStorage {
  constructor(db) {
    this.bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: "registration_documents",
    });
  }
  async save(registrationId, image) {
    const match =
      typeof image === "string" && businessLicensePattern.exec(image);
    if (!match)
      throw new BadRequestError(
        "Vui lòng tải ảnh giấy phép kinh doanh JPG, PNG hoặc WebP.",
      );
    const bytes = Buffer.from(match[2], "base64");
    const valid =
      match[1] === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : match[1] === "png"
          ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (
      !valid ||
      bytes.length < 12 ||
      bytes.length > 1024 * 1024 ||
      bytes.toString("base64") !== match[2]
    )
      throw new BadRequestError(
        "Ảnh giấy phép kinh doanh không hợp lệ hoặc vượt quá 1 MiB sau xử lý.",
      );
    const id = randomUUID();
    const upload = this.bucket.openUploadStreamWithId(
      id,
      `business-license-${registrationId}.${match[1] === "jpeg" ? "jpg" : match[1]}`,
      {
        chunkSizeBytes: 1024 * 1024,
        metadata: { registrationId, contentType: "image/" + match[1] },
      },
    );
    try {
      await pipeline(Readable.from([bytes]), upload);
    } catch (error) {
      await upload.abort().catch(() => {});
      throw error;
    }
    return id;
  }
  async discard(id) {
    await this.bucket.delete(id).catch((error) => {
      if (error.code !== "ENOENT")
        console.error("[Registration] Không dọn được giấy phép của hồ sơ lỗi.");
    });
  }
  async serve(id, registrationId, req, res) {
    const file = await this.bucket
      .find({ _id: id, "metadata.registrationId": registrationId })
      .limit(1)
      .next();
    if (!file)
      throw new NotFoundError("Hồ sơ chưa có ảnh giấy phép kinh doanh.");
    res.set({
      "Content-Type": file.metadata.contentType,
      "Content-Length": String(file.length),
      "Content-Disposition": `inline; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    await pipeline(this.bucket.openDownloadStream(id), res);
  }
}
