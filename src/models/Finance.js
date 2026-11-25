import { Schema } from "mongoose";

export const financeSettingsId = "association";
export const financeTypes = ["INCOME", "EXPENSE"];
export const financeCategories = [
  "MEMBERSHIP_FEE",
  "SPONSORSHIP",
  "ACTIVITY",
  "ADMINISTRATION",
  "EVENT",
  "OTHER",
];
export const financeMethods = ["CASH", "BANK_TRANSFER"];
const options = (collection, timestamps = false) => ({
  collection,
  timestamps,
  versionKey: false,
});
const attachment = new Schema(
  {
    id: String,
    name: String,
    type: String,
    size: Number,
  },
  { _id: false },
);

export default function createFinanceModels(connection) {
  const entry = new Schema(
    {
      _id: String,
      code: { type: String, required: true, unique: true },
      businessDate: { type: String, required: true },
      type: { type: String, enum: financeTypes, required: true },
      amount: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
      content: { type: String, required: true, maxlength: 1000 },
      category: { type: String, enum: financeCategories, required: true },
      paymentMethod: { type: String, enum: financeMethods, required: true },
      counterparty: { type: String, default: "" },
      referenceNo: { type: String, default: "" },
      note: { type: String, default: "" },
      attachments: { type: [attachment], default: [] },
      sourceType: {
        type: String,
        enum: ["MANUAL", "MEMBERSHIP_FEE", "SPONSORSHIP", "ADJUSTMENT"],
        required: true,
      },
      sourceId: String,
      sourceEventKey: String,
      status: { type: String, enum: ["POSTED", "VOIDED"], default: "POSTED" },
      reversalOf: String,
      createdBy: String,
      updatedBy: String,
      version: { type: Number, default: 1 },
    },
    options("finance_transactions", true),
  );
  entry.index({ status: 1, businessDate: 1 });
  entry.index({ businessDate: 1, createdAt: 1, _id: 1 });
  for (const field of ["sourceEventKey", "reversalOf"]) {
    entry.index(
      { [field]: 1 },
      {
        unique: true,
        partialFilterExpression: { [field]: { $type: "string" } },
      },
    );
  }

  const audit = new Schema(
    {
      entityId: String,
      action: String,
      before: Schema.Types.Mixed,
      after: Schema.Types.Mixed,
      reason: String,
      actorId: String,
      createdAt: Date,
    },
    options("finance_audit_logs"),
  );
  audit.index({ entityId: 1, createdAt: 1, _id: 1 });
  const pending = new Schema(
    {
      _id: String,
      postOn: String,
      receipt: Schema.Types.Mixed,
      createdAt: Date,
    },
    options("finance_pending_receipts"),
  );
  pending.index({ postOn: 1, _id: 1 });

  return {
    settings: connection.model(
      "FinanceSettings",
      new Schema(
        {
          _id: String,
          revision: Number,
          openingDate: String,
          openingBalance: Number,
          openingFeePaymentCount: Number,
          closedThrough: String,
          createdBy: String,
          createdAt: Date,
        },
        options("finance_settings"),
      ),
    ),
    entries: connection.model("FinanceTransaction", entry),
    closes: connection.model(
      "FinanceDailyClose",
      new Schema(
        {
          _id: String,
          openingBalance: Number,
          totalIncome: Number,
          totalExpense: Number,
          closingBalance: Number,
          closedBy: String,
          closedAt: Date,
        },
        options("finance_daily_closes"),
      ),
    ),
    audit: connection.model("FinanceAuditLog", audit),
    requests: connection.model(
      "FinanceRequest",
      new Schema(
        {
          _id: String,
          hash: String,
          response: Schema.Types.Mixed,
        },
        options("finance_requests"),
      ),
    ),
    files: connection.model(
      "FinanceAttachment",
      new Schema(
        {
          _id: String,
          entryId: String,
          name: String,
          type: String,
          size: Number,
          bytes: Buffer,
        },
        options("finance_attachments"),
      ),
    ),
    pending: connection.model("FinancePendingReceipt", pending),
  };
}
