import { Schema } from "mongoose";
export const AdminSchema = new Schema(
  {
    _id: { type: String, required: true },
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true },
    role: {
      type: String,
      enum: ["SUPER_ADMIN", "STAFF"],
      default: "SUPER_ADMIN",
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "admin_users" },
);

export default function createModel(connection) {
  return connection.model("AdminUser", AdminSchema);
}
