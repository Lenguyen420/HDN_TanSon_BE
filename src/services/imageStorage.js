import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestError } from "../utils/httpError.js";

export const defaultUploadDirectory = fileURLToPath(
  new URL("../../uploads/", import.meta.url),
);
export const imageFolders = ["news", "events", "member-visits", "banners"];
export const uploadedImagePattern =
  /^uploads\/(news|events|member-visits|banners)\/[a-f0-9-]{36}\.(jpg|png|webp)$/;

export class ImageStorage {
  constructor(directory = defaultUploadDirectory, bucket = null) {
    this.directory = directory;
    this.bucket = bucket;
  }

  async initialize() {
    // Vercel has no persistent writable uploads directory.
    if (this.bucket || process.env.VERCEL === "1") return;
    await Promise.all(
      imageFolders.map((folder) =>
        mkdir(path.join(this.directory, folder), { recursive: true }),
      ),
    );
  }

  async prepare(image, folder) {
    if (
      process.env.VERCEL === "1" &&
      !this.bucket &&
      image?.startsWith("data:")
    )
      throw new BadRequestError(
        "Tải ảnh lên ổ đĩa không được hỗ trợ trên Vercel. Hãy dùng URL ảnh HTTP(S) từ dịch vụ lưu trữ.",
      );
    if (!image || !image.startsWith("data:")) {
      if (image?.startsWith("uploads/")) {
        if (!uploadedImagePattern.test(image))
          throw new BadRequestError("Đường dẫn ảnh không hợp lệ.");
        try {
          if (this.bucket) {
            const stored = await this.bucket
              .find({ filename: image })
              .limit(1)
              .next();
            if (!stored) throw new Error("Missing image");
          } else {
            await access(
              path.join(this.directory, ...image.split("/").slice(1)),
            );
          }
        } catch {
          throw new BadRequestError("Ảnh tải lên không còn tồn tại.");
        }
      }
      return { image };
    }
    if (!imageFolders.includes(folder))
      throw new BadRequestError("Chức năng không hỗ trợ tải ảnh.");
    const match =
      /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) throw new BadRequestError("Ảnh tải lên không hợp lệ.");
    const bytes = Buffer.from(match[2], "base64");
    const valid =
      match[1] === "jpeg"
        ? bytes.length >= 4 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes[2] === 0xff
        : match[1] === "png"
          ? bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : bytes.length >= 20 &&
            bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid || bytes.toString("base64") !== match[2])
      throw new BadRequestError(
        "Nội dung ảnh không đúng định dạng JPG, PNG hoặc WebP.",
      );
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const filename = `${randomUUID()}.${extension}`;
    const imagePath = `uploads/${folder}/${filename}`;
    if (this.bucket) {
      // Resized form images fit in one chunk instead of several default 255 KiB
      // chunks. Existing files retain their own GridFS chunk size when read.
      const upload = this.bucket.openUploadStream(imagePath, {
        chunkSizeBytes: 2 * 1024 * 1024,
      });
      try {
        await pipeline(Readable.from([bytes]), upload);
      } catch (error) {
        await upload.abort().catch(() => {});
        throw error;
      }
      return { image: imagePath, gridFsId: upload.id };
    }
    const file = path.join(this.directory, folder, filename);
    await writeFile(file, bytes, { flag: "wx" });
    return { image: `uploads/${folder}/${filename}`, file };
  }

  middleware() {
    return async (req, res, next) => {
      if (!this.bucket) return next();
      const image = "uploads" + req.path;
      if (
        !["GET", "HEAD"].includes(req.method) ||
        !uploadedImagePattern.test(image)
      )
        return res.status(404).end();
      try {
        const file = await this.bucket
          .find({ filename: image })
          .limit(1)
          .next();
        if (!file) return res.status(404).end();
        const extension = image.split(".").pop();
        res.set({
          "Content-Type":
            extension === "jpg" ? "image/jpeg" : "image/" + extension,
          "Content-Length": String(file.length),
          "Cache-Control": "public, max-age=31536000, immutable",
          "Cross-Origin-Resource-Policy": "cross-origin",
        });
        if (req.method === "HEAD") return res.end();
        await pipeline(this.bucket.openDownloadStream(file._id), res);
      } catch (error) {
        if (res.headersSent) res.destroy();
        else next(error);
      }
    };
  }

  async discard(prepared) {
    if (prepared.gridFsId && this.bucket)
      await this.bucket.delete(prepared.gridFsId).catch(() => {
        console.error(
          "[Uploads] Không dọn được ảnh MongoDB của yêu cầu thất bại.",
        );
      });
    if (prepared.file)
      await unlink(prepared.file).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("[Uploads] Không dọn được ảnh của yêu cầu thất bại.");
      });
  }
}
