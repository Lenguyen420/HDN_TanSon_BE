import { randomUUID } from "node:crypto";
import { validateEventFile } from "./eventFileService.js";
import { HttpError } from "../utils/httpError.js";

export function prepareFinanceAttachments(uploads = []) {
  let total = 0;
  return uploads.map(({ name, base64 }) => {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64)
      throw new HttpError(400, "Chứng từ phải dùng base64 chuẩn.");
    total += bytes.length;
    if (bytes.length > 1024 * 1024 || total > 2 * 1024 * 1024)
      throw new HttpError(
        413,
        "Chứng từ tối đa 1 MiB mỗi tệp và 2 MiB mỗi lần gửi.",
      );
    const file = validateEventFile(bytes, encodeURIComponent(name));
    if (!["pdf", "jpeg", "jpg", "png", "webp"].includes(file.extension))
      throw new HttpError(400, "Chứng từ chỉ hỗ trợ PDF và ảnh JPG/PNG/WebP.");
    return {
      id: randomUUID(),
      name: file.name,
      type: file.type,
      size: bytes.length,
      bytes,
    };
  });
}

export async function storeFinanceAttachments(
  model,
  entryId,
  prepared,
  session,
) {
  if (prepared.length)
    await model.insertMany(
      prepared.map(({ id, ...file }) => ({
        _id: id,
        ...file,
        entryId,
      })),
      { session },
    );
  return prepared.map(({ bytes, ...metadata }) => metadata);
}
