import { financeError, requireOpenDate } from "./financeShared.js";

export function receiveSponsorship(finance, id, input, actorId, key) {
  return finance.write((settings, session) =>
    finance.once(
      "RECEIVE_SPONSORSHIP",
      actorId,
      key,
      { id, ...input },
      session,
      async () => {
        const contributions = finance.partners.contributions;
        const row = await contributions
          .findOne({ _id: id, deletedAt: null })
          .session(session)
          .lean();
        if (!row)
          throw financeError(
            404,
            "FINANCE_SPONSORSHIP_NOT_FOUND",
            "Không tìm thấy khoản tài trợ.",
          );
        if (row.financeReceiptId)
          throw financeError(
            409,
            "FINANCE_SPONSORSHIP_ALREADY_RECEIVED",
            "Khoản tài trợ đã từng được xác nhận thực nhận.",
          );
        requireOpenDate(settings, input.businessDate);
        if (
          row.type !== "money" ||
          !Number.isSafeInteger(row.amount) ||
          row.amount <= 0 ||
          !["bank_transfer", "cash"].includes(row.paymentMethod)
        )
          throw financeError(
            422,
            "FINANCE_SPONSORSHIP_NOT_CASH",
            "Chỉ xác nhận tài trợ tiền có số tiền và hình thức hợp lệ.",
          );

        const partner = await finance.partners.partners
          .findById(row.partnerId)
          .session(session)
          .lean();
        const data = await finance.postSource(
          settings,
          {
            businessDate: input.businessDate,
            type: "INCOME",
            amount: row.amount,
            content: "Thu tài trợ: " + row.title,
            category: "SPONSORSHIP",
            paymentMethod:
              row.paymentMethod === "cash" ? "CASH" : "BANK_TRANSFER",
            counterparty: partner?.name,
            sourceType: "SPONSORSHIP",
            sourceId: id,
            sourceEventKey: "SPONSORSHIP:" + id + ":received",
          },
          actorId,
          session,
        );
        const at = new Date();
        await contributions.updateOne(
          { _id: id },
          {
            $set: {
              financeReceiptId: data.id,
              financeReceivedAt: at,
              financeReceivedBy: actorId,
              financeReceivedDate: data.businessDate,
            },
            $push: { audit: { action: "finance_received", actorId, at } },
          },
          { session },
        );
        return { data };
      },
    ),
  );
}

export async function refundSponsorship(
  contributions,
  id,
  reversal,
  actorId,
  session,
) {
  const at = new Date();
  const row = await contributions.updateOne(
    {
      _id: id,
      financeReceiptId: reversal.reversalOf,
      financeRefundId: null,
    },
    {
      $set: {
        financeRefundId: reversal.id,
        financeRefundedAt: at,
        financeRefundedBy: actorId,
      },
      $push: { audit: { action: "finance_refunded", actorId, at } },
    },
    { session },
  );
  if (!row.matchedCount)
    throw financeError(
      409,
      "FINANCE_SOURCE_CONFLICT",
      "Khoản tài trợ đã thay đổi hoặc không thể hoàn tiền.",
    );
}

export async function refundMembershipFee(
  service,
  id,
  reversal,
  actorId,
  session,
) {
  const payment = await service.payments.findById(id).session(session).lean();
  const due =
    payment &&
    (await service.dues.findById(payment.dueId).session(session).lean());
  if (
    !due ||
    due.status !== "paid" ||
    payment.status !== "confirmed" ||
    payment.financeRefundId ||
    due.transactionRef !== payment.transactionRef
  )
    throw financeError(
      409,
      "FINANCE_SOURCE_CONFLICT",
      "Thanh toán hội phí đã thay đổi hoặc không thể hoàn tiền.",
    );
  const campaign = await service.lock(due.campaignId, session);
  const at = new Date();
  const audit = { action: "refunded", actorId, at, note: reversal.note };
  await service.payments.updateOne(
    { _id: id },
    {
      $set: {
        financeRefundId: reversal.id,
        financeRefundedAt: at,
        financeRefundedBy: actorId,
      },
      $push: { audit },
    },
    { session },
  );
  // Preserve the original settled payment and its proof. Only reopen the obligation.
  await service.dues.updateOne(
    { _id: due._id },
    {
      $set: {
        status: campaign.status === "published" ? "unpaid" : "cancelled",
      },
      $unset: {
        paidAt: 1,
        confirmedBy: 1,
        paymentMethod: 1,
        transactionRef: 1,
      },
      $push: { audit },
    },
    { session },
  );
}
