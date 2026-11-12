import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BadRequestError,
  NotFoundError,
  HttpError,
} from "../utils/httpError.js";
export const videoChunkSize = 2 * 1024 * 1024;
export const maxIntroductionVideoSize = 100 * 1024 * 1024;
export const managedVideoPattern =
  /^\/api\/v1\/public\/introduction-videos\/([a-f0-9-]{36})$/;
const expiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (data) =>
  Buffer.isBuffer(data) ? data : Buffer.from(data.buffer);
export class IntroductionVideoService {
  constructor(db) {
    this.files = db.collection("introduction_videos");
    this.parts = db.collection("introduction_video_parts");
  }
  async initialize() {
    await Promise.all([
      this.files.createIndex({ status: 1, expiresAt: 1 }),
      this.parts.createIndex({ uploadId: 1, index: 1 }, { unique: true }),
    ]);
  }
  async cleanup() {
    for (let i = 0; i < 10; i++) {
      const old = await this.files.findOneAndUpdate(
        { status: "uploading", expiresAt: { $lte: new Date() } },
        { $set: { status: "deleting" } },
        { returnDocument: "after" },
      );
      if (!old) break;
      await this.parts.deleteMany({ uploadId: old._id });
      await this.files.deleteOne({ _id: old._id, status: "deleting" });
    }
  }
  async create(dto, owner) {
    const name = dto.name
      .replace(/[\\/]/g, "_")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim();
    const extension = name.split(".").pop().toLowerCase();
    if (!["mp4", "webm"].includes(extension))
      throw new BadRequestError("Chỉ hỗ trợ video MP4 hoặc WebM.");
    await this.cleanup();
    const id = randomUUID(),
      count = Math.ceil(dto.size / videoChunkSize);
    await this.files.insertOne({
      _id: id,
      name,
      size: dto.size,
      type: extension === "mp4" ? "video/mp4" : "video/webm",
      owner,
      status: "uploading",
      count,
      createdAt: new Date(),
      expiresAt: expiry(),
    });
    return { data: { id, chunkSize: videoChunkSize, count } };
  }
  async owned(id, owner) {
    const file = await this.files.findOne({ _id: id, owner });
    if (
      !file ||
      file.status === "deleting" ||
      (file.status !== "complete" && file.expiresAt <= new Date())
    )
      throw new NotFoundError("Phiên tải video không tồn tại hoặc đã hết hạn.");
    return file;
  }
  async putPart(id, index, bytes, owner) {
    const file = await this.owned(id, owner);
    if (!Number.isInteger(index) || index < 0 || index >= file.count)
      throw new BadRequestError("Số thứ tự phần video không hợp lệ.");
    const expected = Math.min(
      videoChunkSize,
      file.size - index * videoChunkSize,
    );
    if (!Buffer.isBuffer(bytes) || bytes.length !== expected)
      throw new BadRequestError("Dung lượng phần video không khớp.");
    if (index === 0) {
      const valid =
        file.type === "video/mp4"
          ? bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"
          : bytes.length >= 4 &&
            bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
      if (!valid)
        throw new BadRequestError(
          "Nội dung file không phải video MP4/WebM hợp lệ.",
        );
    }
    if (file.status !== "complete") {
      const active = await this.files.updateOne(
        { _id: id, owner, status: "uploading", expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: expiry() } },
      );
      if (!active.matchedCount)
        throw new HttpError(
          409,
          "Phiên tải video đã thay đổi. Vui lòng thử lại.",
        );
    }
    const digest = hash(bytes),
      filter = { uploadId: id, index };
    let part = await this.parts.findOne(filter, { projection: { digest: 1 } });
    if (part) {
      if (part.digest !== digest)
        throw new HttpError(409, "Phần video đã tải có nội dung khác.");
      return { success: true };
    }
    if (file.status === "complete")
      throw new HttpError(409, "Video đã hoàn tất.");
    try {
      await this.parts.insertOne({
        ...filter,
        data: bytes,
        length: bytes.length,
        digest,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      part = await this.parts.findOne(filter, { projection: { digest: 1 } });
      if (part.digest !== digest)
        throw new HttpError(409, "Phần video đã tải có nội dung khác.");
    }
    return { success: true };
  }
  async complete(id, owner) {
    const file = await this.owned(id, owner);
    if (file.status !== "complete") {
      const parts = await this.parts
        .find({ uploadId: id }, { projection: { index: 1, length: 1 } })
        .sort({ index: 1 })
        .toArray();
      if (
        parts.length !== file.count ||
        parts.some(
          (part, index) =>
            part.index !== index ||
            part.length !==
              Math.min(videoChunkSize, file.size - index * videoChunkSize),
        )
      )
        throw new HttpError(409, "Video chưa tải đủ các phần.");
      const updated = await this.files.updateOne(
        { _id: id, owner, status: "uploading", expiresAt: { $gt: new Date() } },
        {
          $set: { status: "complete", completedAt: new Date() },
          $unset: { expiresAt: "" },
        },
      );
      if (
        !updated.matchedCount &&
        (await this.owned(id, owner)).status !== "complete"
      )
        throw new HttpError(409, "Phiên tải video đã hết hạn.");
    }
    return {
      data: {
        url: "/api/v1/public/introduction-videos/" + id,
        name: file.name,
        size: file.size,
      },
    };
  }
  async cancel(id, owner) {
    const file = await this.files.findOneAndUpdate(
      { _id: id, owner, status: "uploading" },
      { $set: { status: "deleting" } },
      { returnDocument: "after" },
    );
    if (file) {
      await this.parts.deleteMany({ uploadId: id });
      await this.files.deleteOne({ _id: id, status: "deleting" });
    }
    return { success: true };
  }
  async exists(id) {
    return !!(await this.files.findOne(
      { _id: id, status: "complete" },
      { projection: { _id: 1 } },
    ));
  }
  async serve(id, req, res) {
    const file = await this.files.findOne({ _id: id, status: "complete" });
    if (!file) throw new NotFoundError("Không tìm thấy video.");
    const range = req.get("Range");
    let start = 0,
      end = file.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return res
          .status(416)
          .set("Content-Range", "bytes */" + file.size)
          .end();
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          return res
            .status(416)
            .set("Content-Range", "bytes */" + file.size)
            .end();
        start = Math.max(0, file.size - suffix);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= file.size ||
        end < start
      )
        return res
          .status(416)
          .set("Content-Range", "bytes */" + file.size)
          .end();
      end = Math.min(end, file.size - 1, start + videoChunkSize - 1);
      res
        .status(206)
        .set("Content-Range", "bytes " + start + "-" + end + "/" + file.size);
    }
    res.set({
      "Content-Type": file.type,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") return res.end();
    const parts = this.parts;
    async function* data() {
      const first = Math.floor(start / videoChunkSize),
        last = Math.floor(end / videoChunkSize);
      let expected = first;
      const cursor = parts
        .find({ uploadId: id, index: { $gte: first, $lte: last } })
        .sort({ index: 1 });
      for await (const part of cursor) {
        if (part.index !== expected++) throw new Error("Missing video part");
        const bytes = bytesOf(part.data);
        const offset = part.index * videoChunkSize;
        yield bytes.subarray(
          Math.max(0, start - offset),
          Math.min(bytes.length, end - offset + 1),
        );
      }
      if (expected !== last + 1) throw new Error("Incomplete video storage");
    }
    await pipeline(Readable.from(data()), res);
  }
}
