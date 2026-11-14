import { Schema } from "mongoose";
import { categories } from "../dto/localgo.dto.js";

export const LocalGoPlaceSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: categories.map(({ code }) => code),
    },
    description: { type: String, required: true },
    content: { type: String, default: "" },
    address: { type: String, required: true },
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: (v) =>
            v.length === 2 &&
            v.every(Number.isFinite) &&
            Math.abs(v[0]) <= 180 &&
            Math.abs(v[1]) <= 90,
          message: "Tọa độ GeoJSON không hợp lệ.",
        },
      },
    },
    coverImage: { type: String, required: true },
    images: { type: [String], default: [] },
    phone: String,
    website: String,
    zalo: String,
    openingHours: [
      new Schema({ day: Number, open: String, close: String }, { _id: false }),
    ],
    memberId: { type: String, default: null, immutable: true },
    createdBy: { type: String, required: true, immutable: true },
    status: { type: String, enum: ["published"], default: "published" },
    isVisible: { type: Boolean, default: true },
    publishedAt: { type: Date, required: true },
    deletedAt: { type: Date, default: null },
    auditLog: {
      type: [
        new Schema(
          {
            action: String,
            actorId: String,
            reason: String,
            at: Date,
          },
          { _id: false },
        ),
      ],
      select: false,
      default: [],
    },
  },
  { timestamps: true, collection: "localgo_places" },
);
LocalGoPlaceSchema.index({ location: "2dsphere" });
LocalGoPlaceSchema.index({
  deletedAt: 1,
  status: 1,
  isVisible: 1,
  category: 1,
  createdAt: -1,
  _id: 1,
});
LocalGoPlaceSchema.index({ memberId: 1, deletedAt: 1, createdAt: -1, _id: 1 });
export default function createModel(connection) {
  return connection.model("LocalGoPlace", LocalGoPlaceSchema);
}
