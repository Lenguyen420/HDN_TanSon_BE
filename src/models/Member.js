import { Schema } from "mongoose";
export const MemberSchema = new Schema(
  {
    _id: { type: String, required: true },
    sourceRegistrationId: String,
    zaloUserId: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    phone: String,
    email: String,
    jobTitle: String,
    birthDate: String,
    joinedAt: { type: String, required: true },
    companyAddress: String,
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    isBoard: { type: Boolean, default: false },
    position: { type: String, default: "Hội viên" },
    initials: String,
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "members" },
);
MemberSchema.index({ deletedAt: 1, createdAt: -1, _id: 1 });
MemberSchema.index(
  { zaloUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { zaloUserId: { $type: "string" } },
  },
);
MemberSchema.index({ isBoard: 1, status: 1 });
MemberSchema.index(
  { sourceRegistrationId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceRegistrationId: { $type: "string" } },
  },
);

export default function createModel(connection) {
  return connection.model("Member", MemberSchema);
}
