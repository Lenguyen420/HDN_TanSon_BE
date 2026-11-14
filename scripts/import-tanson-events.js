import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mongoose from "mongoose";
import { loadEnvironment } from "../src/config/environment.js";
import connectDB from "../src/config/database.js";
import createContentModels from "../src/models/Content.js";
import { contentDefinitions } from "../src/dto/content.dto.js";

const [sourcePath, logoPath] = process.argv.slice(2);
if (!sourcePath || !logoPath)
  throw Error(
    "Cần đường dẫn file JSON và ảnh logo JPG; thêm --apply để import.",
  );
const apply = process.argv.includes("--apply");
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes.toString("utf8").replace(/^\uFEFF/, ""));
if (!Array.isArray(source) || !source.length)
  throw Error("File cần là danh sách sự kiện không rỗng.");
const logo = await readFile(logoPath);
if (logo[0] !== 0xff || logo[1] !== 0xd8)
  throw Error("Ảnh mặc định phải là JPG.");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const logoHash = hash(logo);
const imageId = `${logoHash.slice(0, 8)}-${logoHash.slice(8, 12)}-4${logoHash.slice(13, 16)}-8${logoHash.slice(17, 20)}-${logoHash.slice(20, 32)}`;
const image = `uploads/events/${imageId}.jpg`;
const text = (value) =>
  String(value ?? "")
    .trim()
    .replaceAll("Hội Doanh nhân", "Hội Doanh nghiệp");
const minutes = (value) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw Error(`Giờ không hợp lệ: ${value}`);
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
const time = (value) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const items = source.map((row, index) => {
  const title = text(row.tieu_de);
  const start = text(row.gio_bat_dau);
  const end = text(row.gio_ket_thuc);
  const startMinutes = minutes(start),
    endMinutes = minutes(end);
  if (endMinutes <= startMinutes)
    throw Error(`Sự kiện ${index + 1}: giờ kết thúc phải sau giờ bắt đầu.`);
  const agendaLines = text(row.lich_trinh)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const host = text(row.don_vi_to_chuc) || "Hội Doanh nghiệp Phường Tân Sơn";
  const date = text(row.ngay_to_chuc);
  const id =
    "import-event-" +
    hash(title.toLocaleLowerCase("vi") + "|" + date).slice(0, 24);
  const status = {
    "Đã công bố": "published",
    "Bản nháp": "draft",
    published: "published",
    draft: "draft",
  }[text(row.trang_thai)];
  if (!status)
    throw Error(`Sự kiện ${index + 1}: trạng thái không được hỗ trợ.`);
  return contentDefinitions.events.body.parse({
    id,
    title,
    topic: text(row.chuyen_muc) || "Hoạt động Hội",
    publishedAt: text(row.ngay_cong_bo) || "2026-11-13",
    status,
    image: text(row.hinh_anh) || image,
    author: text(row.tac_gia) || host,
    summary: text(row.tom_tat) || title,
    paragraphs: (text(row.noi_dung) || text(row.tom_tat) || title)
      .split(/\n\s*\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    event: {
      date,
      time: `${start} – ${end}`,
      venue: text(row.dia_diem) || "Phường Tân Sơn",
      address: text(row.dia_chi) || "Phường Tân Sơn, TP. Hồ Chí Minh",
      host,
      checkInEnabled: row.mo_diem_danh === true,
      documents: [],
      minutes: [],
      agenda: agendaLines.map((title, i) => ({
        time: time(
          startMinutes +
            Math.floor(
              ((endMinutes - startMinutes) * i) / agendaLines.length / 5,
            ) *
              5,
        ),
        title,
      })),
    },
  });
});
if (new Set(items.map((item) => item.id)).size !== items.length)
  throw Error("File có sự kiện trùng tiêu đề và ngày tổ chức.");
const directory = path.resolve("imports");
await mkdir(directory, { recursive: true });
const stem = path.basename(sourcePath, path.extname(sourcePath));
await writeFile(
  path.join(directory, `${stem}.normalized.json`),
  JSON.stringify(items, null, 2) + "\n",
);
const connection = await connectDB(loadEnvironment().get("MONGODB_URI"));
const model = createContentModels(connection).events;
const bucket = new mongoose.mongo.GridFSBucket(connection.db, {
  bucketName: "images",
});
const duplicate = (item) => ({
  $or: [
    { _id: item.id },
    { title: item.title, "event.date": item.event.date },
    {
      title: source[items.indexOf(item)].tieu_de.trim(),
      "event.date": item.event.date,
    },
  ],
});
let newImageId;
try {
  const existing = await model
    .find({ $or: items.map(duplicate) })
    .select("_id title event.date deletedAt")
    .lean();
  const report = {
    source: path.basename(sourcePath),
    sourceSha256: hash(sourceBytes),
    mode: apply ? "applied" : "preview",
    notes: [
      "Ảnh trống dùng logo Hội.",
      "Giờ từng mục lịch trình tự phân chia từ khung giờ trong file mẫu.",
      "Chuẩn hóa tên Hội Doanh nghiệp Phường Tân Sơn.",
      "Không ghi đè sự kiện đã tồn tại, kể cả bản đã xóa mềm.",
    ],
    total: items.length,
    existingMatches: existing.length,
    inserted: [],
    skipped: [],
    verified: 0,
  };
  if (apply) {
    const hasNew = items.some(
      (item) =>
        !existing.some(
          (row) =>
            row._id === item.id ||
            ((row.title === item.title ||
              row.title === source[items.indexOf(item)].tieu_de.trim()) &&
              row.event.date === item.event.date),
        ),
    );
    if (hasNew && items.some((item) => item.image === image)) {
      const stored = await bucket.find({ filename: image }).limit(1).next();
      if (!stored) {
        const upload = bucket.openUploadStream(image, {
          metadata: { sha256: logoHash, purpose: "event-import-default-logo" },
        });
        newImageId = upload.id;
        await pipeline(Readable.from([logo]), upload);
      }
    }
    await connection.transaction(async (session) => {
      report.inserted = [];
      report.skipped = [];
      for (const item of items) {
        const old = await model
          .findOne(duplicate(item))
          .session(session)
          .lean();
        if (old) {
          report.skipped.push({ id: old._id, title: old.title });
          continue;
        }
        const { id, ...fields } = item;
        await model.create([{ _id: id, ...fields }], { session });
        report.inserted.push({ id, title: item.title });
      }
    });
    for (const item of items) {
      if (await model.exists(duplicate(item))) report.verified++;
    }
    if (report.verified !== items.length)
      throw Error("Số bản ghi xác nhận sau import không khớp.");
  }
  await writeFile(
    path.join(directory, `${stem}.${apply ? "report" : "preview"}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      mode: report.mode,
      total: report.total,
      existingMatches: report.existingMatches,
      inserted: report.inserted.length,
      skipped: report.skipped.length,
      verified: report.verified,
    }),
  );
} catch (error) {
  if (newImageId && !(await model.exists({ image })))
    await bucket.delete(newImageId).catch(() => {});
  throw error;
} finally {
  await connection.close();
}
