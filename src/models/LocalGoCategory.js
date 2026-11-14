import { Schema } from "mongoose";
const schema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 1000 },
    revision: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "localgo_categories" },
);
export default function createModel(connection) {
  return connection.model("LocalGoCategory", schema);
}
