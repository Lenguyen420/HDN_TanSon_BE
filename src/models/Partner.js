import { Schema } from "mongoose";
export default function createPartnerModels(connection) {
  const audit = new Schema(
    { action: String, actorId: String, at: Date },
    { _id: false },
  );
  const common = {
    _id: { type: String, required: true },
    isPublished: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    createdBy: String,
    updatedBy: String,
    requestHash: String,
    audit: [audit],
  };
  const partner = new Schema(
    {
      ...common,
      name: { type: String, required: true },
      logo: String,
      industry: String,
      description: String,
      address: String,
      website: String,
      memberId: { type: String, default: null },
      notification: {
        status: { type: String, enum: ["none", "sent"], default: "none" },
        sentAt: Date,
      },
    },
    { collection: "partners", timestamps: true, versionKey: false },
  );
  partner.index({ deletedAt: 1, isPublished: 1, updatedAt: -1 });
  const contribution = new Schema(
    {
      ...common,
      partnerId: { type: String, required: true },
      title: { type: String, required: true },
      type: { type: String, enum: ["money", "in_kind"], required: true },
      paymentMethod: {
        type: String,
        enum: ["cash", "bank_transfer", null],
        default: null,
      },
      amount: { type: Number, min: 0, default: null },
      currency: { type: String, default: "VND" },
      itemName: String,
      quantity: Number,
      estimatedValue: Number,
      contributionDate: String,
      description: String,
      eventId: { type: String, default: null },
      images: { type: [String], default: [] },
      notification: {
        status: {
          type: String,
          enum: ["none", "pending", "sent", "failed"],
          default: "none",
        },
        sentAt: Date,
        error: String,
      },
    },
    {
      collection: "partner_contributions",
      timestamps: true,
      versionKey: false,
    },
  );
  contribution.index({
    partnerId: 1,
    deletedAt: 1,
    isPublished: 1,
    contributionDate: -1,
  });
  return {
    partners: connection.model("Partner", partner),
    contributions: connection.model("PartnerContribution", contribution),
  };
}
