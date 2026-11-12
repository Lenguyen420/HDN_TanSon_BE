import { Schema } from "mongoose";
const schema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    avatar: { type: String, default: "" },
    phone: { type: String, default: null },
    profileConsentAt: Date,
    phoneConsentAt: Date,
    lastLoginAt: Date,
  },
  { timestamps: true, collection: "zalo_users" },
);
export default function createZaloUserModel(connection) {
  return connection.model("ZaloUser", schema);
}
