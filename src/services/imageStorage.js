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
  constructor(directory = defaultUploadDirectory) {
    this.directory = directory;
  }

  async initialize() {
    await Promise.all(
      imageFolders.map((folder) =>
        mkdir(path.join(this.directory, folder), { recursive: true }),
      ),
    );
  }

  async prepare(image, folder) {
    if (!image || !image.startsWith("data:")) {
      if (image?.startsWith("uploads/")) {
        if (!uploadedImagePattern.test(image))
          throw new BadRequestError("Đường dẫn ảnh không hợp lệ.");
        try {
          await access(path.join(this.directory, ...image.split("/").slice(1)));
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
    const file = path.join(this.directory, folder, filename);
    await writeFile(file, bytes, { flag: "wx" });
    return { image: `uploads/${folder}/${filename}`, file };
  }

  async discard(prepared) {
    if (prepared.file)
      await unlink(prepared.file).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("[Uploads] Không dọn được ảnh của yêu cầu thất bại.");
      });
  }
}
