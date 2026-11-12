import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  BadRequestError,
  HttpError,
  NotFoundError,
} from "../utils/httpError.js";

const types = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
export const maxEventFileSize = 4 * 1024 * 1024;
export function validateEventFile(bytes, encodedName) {
  let decoded;
  try {
    decoded = decodeURIComponent(encodedName);
  } catch {
    throw new BadRequestError("Tên file không hợp lệ.");
  }
  const name = path.posix
    .basename(path.win32.basename(decoded))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  const extension = name.split(".").pop()?.toLowerCase();
  if (!name || name.length > 200 || !types[extension])
    throw new BadRequestError(
      "Chỉ hỗ trợ PDF, Word, Excel, PowerPoint và ảnh JPG/PNG/WebP.",
    );
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    throw new BadRequestError("Vui lòng chọn file có nội dung.");
  if (bytes.length > maxEventFileSize)
    throw new HttpError(413, "Mỗi file không được vượt quá 4 MB.");
  const valid =
    extension === "pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : ["docx", "xlsx", "pptx"].includes(extension)
        ? bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex"))
        : ["doc", "xls", "ppt"].includes(extension)
          ? bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
          : ["jpg", "jpeg"].includes(extension)
            ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
            : extension === "png"
              ? bytes.length >= 24 &&
                bytes
                  .subarray(0, 8)
                  .equals(Buffer.from("89504e470d0a1a0a", "hex"))
              : bytes.length >= 20 &&
                bytes.toString("ascii", 0, 4) === "RIFF" &&
                bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid)
    throw new BadRequestError("Nội dung file không khớp định dạng đã chọn.");
  return { name, type: types[extension], extension };
}
export class EventFileService {
  constructor(bucket) {
    this.bucket = bucket;
  }
  async upload(bytes, encodedName, adminId) {
    const file = validateEventFile(bytes, encodedName);
    const id = randomUUID();
    const stream = this.bucket.openUploadStreamWithId(id, file.name, {
      chunkSizeBytes: 1024 * 1024,
      metadata: { type: file.type, uploadedBy: adminId },
    });
    try {
      await pipeline(Readable.from([bytes]), stream);
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return {
      data: {
        url: `/api/v1/public/event-files/${id}`,
        name: file.name,
        size: bytes.length,
      },
    };
  }
  async serve(id, request, response) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new NotFoundError("Không tìm thấy file.");
    const file = await this.bucket.find({ _id: id }).limit(1).next();
    if (!file) throw new NotFoundError("Không tìm thấy file.");
    const type = file.metadata?.type || "application/octet-stream";
    const inline = type === "application/pdf" || type.startsWith("image/");
    response.set({
      "Content-Type": type,
      "Content-Length": String(file.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="event-file${path.extname(file.filename).toLowerCase()}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (request.method === "HEAD") return response.end();
    await pipeline(this.bucket.openDownloadStream(file._id), response);
  }
}
