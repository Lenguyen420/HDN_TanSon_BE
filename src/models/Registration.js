import { Schema } from "mongoose";
export const RegistrationSchema = new Schema(
  {
    _id: { type: String, required: true },
    fullName: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    email: String,
    birthDate: String,
    jobTitle: String,
    companyAddress: String,
    taxCode: String,
    date: { type: String, required: true },
    note: String,
    notificationTokenHash: { type: String, select: false, index: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    memberId: String,
    reviewedBy: String,
    reviewedAt: Date,
    rejectionReason: String,
    importedBy: String,
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "registrations" },
);
RegistrationSchema.index({ deletedAt: 1, createdAt: -1, _id: 1 });
RegistrationSchema.index({ deletedAt: 1, status: 1, createdAt: -1, _id: 1 });
RegistrationSchema.index(
  { memberId: 1 },
  { unique: true, partialFilterExpression: { memberId: { $type: "string" } } },
);

export default function createModel(connection) {
  return connection.model("Registration", RegistrationSchema);
}
