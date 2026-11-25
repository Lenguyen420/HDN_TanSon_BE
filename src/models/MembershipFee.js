import { Schema } from "mongoose";
const audit = new Schema(
  { action: String, actorId: String, at: Date, note: String },
  { _id: false },
);
const options = (collection) => ({ timestamps: true, collection });
export default function createMembershipFeeModels(connection) {
  const campaigns = connection.model(
    "MembershipFeeCampaign",
    new Schema(
      {
        _id: String,
        title: String,
        year: Number,
        description: String,
        amount: Number,
        dueDate: String,
        target: { type: String, enum: ["all", "selected"] },
        targetMemberIds: [String],
        status: { type: String, enum: ["draft", "published", "closed"] },
        paymentInstructions: String,
        createdBy: String,
        revision: { type: Number, default: 0 },
        audit: [audit],
      },
      options("membership_fee_campaigns"),
    ),
  );
  const dueSchema = new Schema(
    {
      _id: String,
      campaignId: { type: String, index: true },
      memberId: { type: String, index: true },
      amountDue: Number,
      status: {
        type: String,
        enum: ["unpaid", "pending_confirmation", "paid", "cancelled"],
      },
      paidAt: Date,
      paymentMethod: String,
      transactionRef: String,
      confirmedBy: String,
      audit: [audit],
    },
    options("membership_fee_dues"),
  );
  dueSchema.index({ campaignId: 1, memberId: 1 }, { unique: true });
  const dues = connection.model("MembershipFeeDue", dueSchema);
  const paymentSchema = new Schema(
    {
      _id: String,
      dueId: { type: String, index: true },
      memberId: String,
      amount: Number,
      method: String,
      proofUrl: String,
      proofFileId: { type: String, select: false },
      proofHash: { type: String, select: false },
      transactionRef: String,
      note: String,
      status: { type: String, enum: ["pending", "confirmed", "rejected"] },
      confirmedBy: String,
      confirmedAt: Date,
      transactionKey: String,
      financeRefundId: String,
      financeRefundedAt: Date,
      financeRefundedBy: String,
      audit: [audit],
    },
    options("membership_fee_payments"),
  );
  paymentSchema.index(
    { transactionKey: 1 },
    {
      unique: true,
      partialFilterExpression: { transactionKey: { $type: "string" } },
    },
  );
  const payments = connection.model("MembershipFeePayment", paymentSchema);
  return { campaigns, dues, payments };
}
