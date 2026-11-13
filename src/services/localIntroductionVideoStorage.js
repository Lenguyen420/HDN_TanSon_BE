import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { BadRequestError, HttpError } from "../utils/httpError.js";
import { maxIntroductionVideoSize } from "./introductionVideoService.js";

export const localVideoPattern =
  /^\/uploads\/introduction-videos\/([a-f0-9-]{36}\.(?:mp4|webm))$/;

export class LocalIntroductionVideoStorage {
  constructor(uploadDirectory) {
    this.directory = path.join(uploadDirectory, "introduction-videos");
    const storage = multer.diskStorage({
      destination: (req, file, callback) => {
        mkdir(this.directory, { recursive: true }).then(
          () => callback(null, this.directory),
          callback,
        );
      },
      // Pending files are hidden from express.static until validation finishes.
      filename: (req, file, callback) => callback(null, `.${randomUUID()}.tmp`),
    });
    this.receive = multer({
      storage,
      limits: {
        fileSize: maxIntroductionVideoSize,
        files: 1,
        fields: 0,
        parts: 1,
      },
      fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const type = { ".mp4": "video/mp4", ".webm": "video/webm" }[extension];
        if (!type || file.mimetype !== type)
          return callback(
            new BadRequestError(
              "Chỉ hỗ trợ file MP4 hoặc WebM với Content-Type tương ứng.",
            ),
          );
        callback(null, true);
      },
    }).single("video");
  }
  middleware() {
    return (req, res, next) => {
      if (process.env.VERCEL === "1")
        return next(
          new HttpError(
            503,
            "Lưu video vào uploads cần backend có ổ đĩa bền vững; không hỗ trợ trên Vercel.",
          ),
        );
      this.receive(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError)
          return next(
            new HttpError(
              error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
              error.code === "LIMIT_FILE_SIZE"
                ? "Video vượt quá giới hạn 100 MiB."
                : "Chỉ gửi một file ở trường video, không kèm trường khác.",
            ),
          );
        next(
          error instanceof HttpError
            ? error
            : new BadRequestError("Dữ liệu tải video không hợp lệ."),
        );
      });
    };
  }
  async finish(file) {
    if (!file) throw new BadRequestError("Vui lòng chọn video cần lưu.");
    const handle = await open(file.path, "r");
    const header = Buffer.alloc(12);
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(header, 0, 12, 0));
    } finally {
      await handle.close();
    }
    const valid =
      file.mimetype === "video/mp4"
        ? header.toString("ascii", 4, 8) === "ftyp"
        : header.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
    if (bytesRead < 12 || !valid)
      throw new BadRequestError(
        "Nội dung file không phải video MP4/WebM hợp lệ.",
      );
    const extension = file.mimetype === "video/mp4" ? "mp4" : "webm";
    const filename = `${randomUUID()}.${extension}`;
    const destination = path.join(this.directory, filename);
    await rename(file.path, destination);
    file.path = destination;
    return {
      url: `/uploads/introduction-videos/${filename}`,
      name: file.originalname,
      size: file.size,
    };
  }
  async exists(url) {
    const match = localVideoPattern.exec(url);
    if (!match) return false;
    try {
      return (await stat(path.join(this.directory, match[1]))).isFile();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  async discard(file) {
    if (file)
      await unlink(file.path).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("[Uploads] Không dọn được video của yêu cầu thất bại.");
      });
  }
}
