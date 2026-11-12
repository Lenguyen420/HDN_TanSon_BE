import mongoose from "mongoose";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { id, fail, ok } from "./tradeShared.js";
export const maxTradeImageBytes = 1024 * 1024;
export class TradeMediaService {
  constructor(core) {
    this.core = core;
    this.bucket = new mongoose.mongo.GridFSBucket(core.connection.db, {
      bucketName: "trade_images",
    });
  }
  async upload(bytes, actor) {
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > maxTradeImageBytes
    )
      fail(
        400,
        "VALIDATION_ERROR",
        "Ảnh giao thương cần có dung lượng không quá 1 MB.",
      );
    const extension =
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
        ? "jpg"
        : bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          ? "png"
          : bytes.length >= 20 &&
              bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP"
            ? "webp"
            : null;
    if (!extension)
      fail(400, "VALIDATION_ERROR", "Chỉ nhận ảnh JPG, PNG hoặc WebP hợp lệ.");
    const mediaId = id(),
      stream = this.bucket.openUploadStream(mediaId + "." + extension, {
        chunkSizeBytes: maxTradeImageBytes,
      });
    try {
      await pipeline(Readable.from([bytes]), stream);
      const row = {
        _id: mediaId,
        ownerId: actor.id,
        fileId: stream.id,
        originalUrl: "/api/v1/trade-media/" + mediaId,
        type: extension === "jpg" ? "image/jpeg" : "image/" + extension,
        length: bytes.length,
        references: [],
        deletedAt: null,
        createdAt: new Date(),
      };
      await this.core.media.insertOne(row);
      return ok({ id: mediaId, url: row.originalUrl });
    } catch (error) {
      await stream.abort().catch(() => {});
      await this.bucket.delete(stream.id).catch(() => {});
      throw error;
    }
  }
  async serve(mediaId, req, res) {
    const row = await this.core.media.findOne({
      _id: mediaId,
      deletedAt: null,
      "references.0": { $exists: true },
    });
    if (!row) return res.status(404).end();
    res.set({
      "Content-Type": row.type,
      "Content-Length": String(row.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (req.method === "HEAD") return res.end();
    await pipeline(this.bucket.openDownloadStream(row.fileId), res);
  }
  async discard(mediaId, actor) {
    const row = await this.core.media.findOne({
      _id: mediaId,
      ownerId: actor.id,
      deletedAt: null,
    });
    if (!row) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy ảnh.");
    if (row.references.length)
      fail(
        409,
        "MEDIA_IN_USE",
        "Ảnh đang được sử dụng trong tin hoặc đánh giá.",
      );
    await this.cleanup([mediaId]);
  }
  async cleanup(ids) {
    for (const mediaId of [...new Set(ids)]) {
      const row = await this.core.media.findOneAndUpdate(
        { _id: mediaId, references: { $size: 0 } },
        { $set: { deletedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!row) continue;
      try {
        await this.bucket.delete(row.fileId);
        await this.core.media.deleteOne({
          _id: mediaId,
          deletedAt: row.deletedAt,
          references: { $size: 0 },
        });
      } catch {
        console.warn("[Trade] Chưa dọn được ảnh không còn sử dụng.");
      }
    }
  }
}
