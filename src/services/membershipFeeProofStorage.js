import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../utils/httpError.js";
export class MembershipFeeProofStorage {
  constructor(db) {
    this.bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: "membership_fee_proofs",
    });
  }
  async save(paymentId, memberId, image) {
    const match =
      typeof image === "string" &&
      /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match)
      throw new HttpError(
        400,
        "Vui lòng chọn ảnh minh chứng JPG, PNG hoặc WebP.",
      );
    const bytes = Buffer.from(match[2], "base64");
    const valid =
      match[1] === "jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
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
      throw new HttpError(
        400,
        "Ảnh minh chứng không hợp lệ hoặc vượt quá 1 MiB sau xử lý.",
      );
    const upload = this.bucket.openUploadStreamWithId(
      paymentId,
      "minh-chung." + (match[1] === "jpeg" ? "jpg" : match[1]),
      { metadata: { memberId, contentType: "image/" + match[1] } },
    );
    try {
      await pipeline(Readable.from([bytes]), upload);
    } catch (e) {
      await upload.abort().catch(() => {});
      throw e;
    }
    return {
      proofFileId: paymentId,
      proofHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  async discard(id) {
    await this.bucket.delete(id).catch(() => {});
  }
  async data(id) {
    const file = await this.bucket.find({ _id: id }).limit(1).next();
    if (!file) throw new HttpError(404, "Không tìm thấy ảnh minh chứng.");
    const chunks = [];
    for await (const chunk of this.bucket.openDownloadStream(id))
      chunks.push(chunk);
    return (
      "data:" +
      file.metadata.contentType +
      ";base64," +
      Buffer.concat(chunks).toString("base64")
    );
  }
  async serve(id, req, res) {
    const file = await this.bucket.find({ _id: id }).limit(1).next();
    if (!file) throw new HttpError(404, "Không tìm thấy ảnh minh chứng.");
    res.set({
      "Content-Type": file.metadata.contentType,
      "Content-Length": String(file.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    if (req.method === "HEAD") return res.end();
    await pipeline(this.bucket.openDownloadStream(id), res);
  }
}
