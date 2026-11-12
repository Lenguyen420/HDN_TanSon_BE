import { z } from "zod";
import { baseQuery, dateSchema, idSchema, text } from "./member.dto.js";
import { uploadedImagePattern } from "../services/imageStorage.js";

// Matches the resized images produced by the admin ImagePicker.
export const imageSchema = text(1_400_000).refine((value) => {
  if (!value) return true;
  if (uploadedImagePattern.test(value)) return true;
  if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    return true;
  if (/^\/(?!\/)[^\s\\]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}, "Ảnh phải là đường dẫn uploads/..., URL HTTP(S), đường dẫn / hoặc ảnh JPG/PNG/WebP base64.");

const eventFile = z.strictObject({
  id: idSchema,
  title: text(300).min(1),
  url: text(2048).refine((value) => {
    if (/^\/api\/v1\/public\/event-files\/[a-f0-9-]{36}$/.test(value))
      return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Tài liệu cần URL HTTPS hợp lệ."),
  publishedAt: dateSchema.optional(),
});
const eventFiles = z
  .array(eventFile)
  .max(100)
  .refine(
    (files) => new Set(files.map((file) => file.id)).size === files.length,
    "Mã tài liệu không được trùng.",
  );
const paragraphs = z.array(text(10_000).min(1)).min(1).max(100);
const status = z.enum(["draft", "published"]);
const article = {
  id: idSchema.optional(),
  title: text(300).min(1),
  topic: text(150).min(1),
  publishedAt: dateSchema,
  status: status.default("draft"),
  image: imageSchema.default(""),
  author: text(150).default(""),
  summary: text(5000).min(1),
  paragraphs,
};

export const contentDefinitions = {
  news: {
    body: z.strictObject(article),
    query: z.strictObject({
      ...baseQuery,
      status: status.optional(),
      topic: text(150).optional(),
    }),
    publicQuery: z.strictObject({ ...baseQuery, topic: text(150).optional() }),
    search: ["title", "topic", "summary", "author"],
    filters: ["status", "topic"],
    sort: { publishedAt: -1, createdAt: -1, _id: 1 },
    dateField: "publishedAt",
  },
  events: {
    body: z.strictObject({
      ...article,
      event: z.strictObject({
        host: text(150).optional(),
        checkInEnabled: z.boolean().optional(),
        documents: eventFiles.optional(),
        minutes: eventFiles.optional(),
        date: dateSchema,
        time: text(150).min(1),
        venue: text(300).min(1),
        address: text(500).min(1),
        agenda: z
          .array(
            z.strictObject({ time: text(100).min(1), title: text(500).min(1) }),
          )
          .max(100)
          .default([]),
      }),
    }),
    query: z.strictObject({
      ...baseQuery,
      status: status.optional(),
      topic: text(150).optional(),
    }),
    publicQuery: z.strictObject({ ...baseQuery, topic: text(150).optional() }),
    search: ["title", "topic", "summary", "event.venue", "event.address"],
    filters: ["status", "topic"],
    sort: { "event.date": -1, createdAt: -1, _id: 1 },
    dateField: "publishedAt",
  },
  "member-visits": {
    body: z.strictObject({
      ...article,
      visit: z.strictObject({
        company: text(250).min(1),
        representative: text(150).min(1),
        date: dateSchema,
        address: text(500).default(""),
        field: text(250).default(""),
      }),
    }),
    query: z.strictObject({
      ...baseQuery,
      status: status.optional(),
      topic: text(150).optional(),
    }),
    publicQuery: z.strictObject({ ...baseQuery, topic: text(150).optional() }),
    search: [
      "title",
      "topic",
      "summary",
      "visit.company",
      "visit.representative",
    ],
    filters: ["status", "topic"],
    sort: { "visit.date": -1, createdAt: -1, _id: 1 },
    dateField: "publishedAt",
  },
  notifications: {
    body: z.strictObject({
      id: idSchema.optional(),
      title: text(300).min(1),
      category: text(150).min(1),
      date: dateSchema,
      time: text(5)
        .regex(/^$|^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .default(""),
      status: status.default("draft"),
      description: text(5000).min(1),
      paragraphs,
    }),
    query: z.strictObject({
      ...baseQuery,
      status: status.optional(),
      category: text(150).optional(),
    }),
    publicQuery: z.strictObject({
      ...baseQuery,
      category: text(150).optional(),
    }),
    search: ["title", "category", "description"],
    filters: ["status", "category"],
    sort: { date: -1, time: -1, createdAt: -1, _id: 1 },
    dateField: "date",
  },
  banners: {
    body: z.strictObject({
      id: idSchema.optional(),
      image: imageSchema.refine(Boolean, "Ảnh banner là bắt buộc."),
      alt: text(300).min(1),
      order: z.number().int().min(1).max(1_000_000),
      status: z.enum(["active", "inactive"]).default("inactive"),
    }),
    query: z.strictObject({
      ...baseQuery,
      status: z.enum(["active", "inactive"]).optional(),
    }),
    publicQuery: z.strictObject(baseQuery),
    search: ["alt"],
    filters: ["status"],
    sort: { order: 1, createdAt: -1, _id: 1 },
  },
};
