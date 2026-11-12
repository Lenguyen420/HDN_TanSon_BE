import { Schema } from "mongoose";

const article = {
  title: { type: String, required: true },
  topic: { type: String, required: true },
  publishedAt: { type: String, required: true },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  image: String,
  author: String,
  summary: { type: String, required: true },
  paragraphs: { type: [String], required: true },
};
const fields = {
  news: article,
  events: {
    ...article,
    event: {
      type: new Schema(
        {
          date: { type: String, required: true },
          time: { type: String, required: true },
          venue: { type: String, required: true },
          address: { type: String, required: true },
          agenda: [new Schema({ time: String, title: String }, { _id: false })],
        },
        { _id: false },
      ),
      required: true,
    },
  },
  "member-visits": {
    ...article,
    visit: {
      type: new Schema(
        {
          company: { type: String, required: true },
          representative: { type: String, required: true },
          date: { type: String, required: true },
          address: String,
          field: String,
        },
        { _id: false },
      ),
      required: true,
    },
  },
  notifications: {
    title: { type: String, required: true },
    category: { type: String, required: true },
    date: { type: String, required: true },
    time: String,
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    description: { type: String, required: true },
    paragraphs: { type: [String], required: true },
  },
  banners: {
    image: { type: String, required: true },
    alt: { type: String, required: true },
    order: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["active", "inactive"], default: "inactive" },
  },
};

export default function createContentModels(connection) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, definition]) => {
      const schema = new Schema(
        {
          _id: { type: String, required: true },
          ...definition,
          deletedAt: { type: Date, default: null },
        },
        {
          collection: key.replaceAll("-", "_"),
          timestamps: true,
          versionKey: false,
        },
      );
      const sort =
        key === "banners"
          ? { order: 1, createdAt: -1, _id: 1 }
          : key === "events"
            ? { "event.date": -1, createdAt: -1, _id: 1 }
            : key === "member-visits"
              ? { "visit.date": -1, createdAt: -1, _id: 1 }
              : key === "notifications"
                ? { date: -1, time: -1, createdAt: -1, _id: 1 }
                : { publishedAt: -1, createdAt: -1, _id: 1 };
      schema.index({ deletedAt: 1, ...sort });
      schema.index({ deletedAt: 1, status: 1, ...sort });
      return [key, connection.model(`Content_${key}`, schema)];
    }),
  );
}
