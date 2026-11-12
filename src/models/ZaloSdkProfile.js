import { Schema } from "mongoose";

const schema = new Schema(
  {
    // Client-reported ID, deliberately isolated from verified ZaloUser records.
    _id: { type: String, required: true },
    name: { type: String, required: true, maxlength: 150 },
    avatar: { type: String, default: "", maxlength: 2048 },
    verificationStatus: {
      type: String,
      enum: ["unverified"],
      default: "unverified",
      immutable: true,
    },
    source: {
      type: String,
      enum: ["mini-app-sdk"],
      default: "mini-app-sdk",
      immutable: true,
    },
    consentReportedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "zalo_sdk_profiles" },
);

export default function createZaloSdkProfileModel(connection) {
  return connection.model("ZaloSdkProfile", schema);
}
