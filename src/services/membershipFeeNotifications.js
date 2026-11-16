const money = (n) => n.toLocaleString("vi-VN") + " ₫";
const notice = (id, title, description, at, dueId) => {
  const date = new Date(at);
  return {
    id,
    title,
    description,
    paragraphs: [description],
    scope: "private",
    source: "membership-fees",
    category: "Hội phí",
    feeDueId: dueId,
    unread: true,
    createdAt: date.toISOString(),
    date: date.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
    time: date.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
};
export async function memberFeeNotifications(memberIds) {
  const active = await this.members
    .find({ _id: { $in: memberIds }, status: "active", deletedAt: null })
    .select("_id")
    .lean();
  if (!active.length) return [];
  const dues = await this.dues
    .find({ memberId: { $in: active.map((m) => m._id) } })
    .lean();
  const campaigns = await this.campaigns
    .find({
      _id: { $in: dues.map((d) => d.campaignId) },
      status: { $in: ["published", "closed"] },
    })
    .lean();
  const assigned = dues.flatMap((d) => {
    const c = campaigns.find((c) => c._id === d.campaignId);
    return c
      ? [
          notice(
            "fee-assigned-" + d._id,
            "Khoản hội phí mới: " + c.title,
            c.title +
              " — " +
              money(d.amountDue) +
              ". Hạn đóng: " +
              c.dueDate.split("-").reverse().join("/") +
              ". Mở Hội phí để xem hướng dẫn thanh toán.",
            d.createdAt || d.audit?.[0]?.at,
            d._id,
          ),
        ]
      : [];
  });
  const payments = await this.payments
    .find({
      dueId: { $in: dues.map((d) => d._id) },
      memberId: { $in: active.map((m) => m._id) },
      status: { $in: ["confirmed", "rejected"] },
    })
    .lean();
  const reviewed = payments.flatMap((payment) => {
    const due = dues.find((d) => d._id === payment.dueId);
    const campaign = campaigns.find((c) => c._id === due?.campaignId);
    const actions =
      payment.status === "confirmed"
        ? ["confirmed", "manual_confirmed"]
        : ["rejected"];
    const decision = [...(payment.audit || [])]
      .reverse()
      .find((a) => actions.includes(a.action));
    // Closing a campaign also rejects pending proofs. Only an admin's actual
    // review produces this result notification, using its persisted reason.
    if (!due || !campaign || !decision) return [];
    const confirmed = payment.status === "confirmed";
    const reason =
      decision.note?.trim() || "Vui lòng liên hệ Ban thư ký để biết chi tiết.";
    const description = confirmed
      ? "Ban thư ký đã xác nhận bạn đã đóng " +
        money(payment.amount) +
        " cho " +
        campaign.title +
        "."
      : "Minh chứng thanh toán cho " +
        campaign.title +
        " đã bị từ chối. Lý do: " +
        reason +
        " Vui lòng mở khoản phí để kiểm tra và gửi lại minh chứng.";
    return [
      notice(
        "fee-reviewed-" + payment._id + "-" + payment.status,
        confirmed
          ? "Đã xác nhận đóng hội phí: " + campaign.title
          : "Minh chứng hội phí bị từ chối: " + campaign.title,
        description,
        payment.confirmedAt || decision.at,
        due._id,
      ),
    ];
  });
  return [...assigned, ...reviewed].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}
export async function adminFeeInbox(query) {
  const [payments, total, pendingCount] = await Promise.all([
    this.payments
      .find({})
      .sort({ createdAt: -1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    this.payments.countDocuments({}),
    this.payments.countDocuments({ status: "pending" }),
  ]);
  const dues = await this.dues
    .find({ _id: { $in: payments.map((p) => p.dueId) } })
    .lean();
  const members = await this.members
    .find({ _id: { $in: payments.map((p) => p.memberId) } })
    .select("_id name")
    .lean();
  const campaigns = await this.campaigns
    .find({ _id: { $in: dues.map((d) => d.campaignId) } })
    .lean();
  return {
    data: payments.map((p) => {
      const d = dues.find((d) => d._id === p.dueId),
        c = campaigns.find((c) => c._id === d?.campaignId),
        m = members.find((m) => m._id === p.memberId);
      return {
        id: "fee-payment-" + p._id,
        paymentId: p._id,
        campaignId: d?.campaignId,
        dueId: p.dueId,
        title:
          p.audit?.[0]?.action === "manual_confirmed"
            ? "Đã ghi nhận hội phí"
            : "Hội viên đã gửi minh chứng đóng phí",
        description:
          (m?.name || p.memberId) +
          " — " +
          (c?.title || "Hội phí") +
          " — " +
          money(p.amount),
        status:
          p.status === "confirmed"
            ? "approved"
            : p.status === "rejected"
              ? "rejected"
              : "pending",
        createdAt: p.createdAt,
        href:
          "/admin/fees?campaignId=" + encodeURIComponent(d?.campaignId || ""),
      };
    }),
    pendingCount,
    pagination: { page: query.page, limit: query.limit, total },
  };
}
