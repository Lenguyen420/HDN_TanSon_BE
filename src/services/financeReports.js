import {
  change,
  contentPattern,
  countDays,
  emptyTotals,
  entryOrder,
  financeError,
  financeRange,
  nextFinanceDay,
  pageResult,
  presentEntry,
  requireBookDate,
  totalsGroup,
} from "./financeShared.js";

function dateFilter(from, to) {
  return { $gte: from, $lte: to };
}

function displayedEntry({ type, q }) {
  return {
    ...(type ? { type } : {}),
    ...(q ? { content: { $regex: contentPattern(q), $options: "i" } } : {}),
  };
}

function limitRange(from, to) {
  if (countDays(from, to) > 366)
    throw financeError(
      422,
      "FINANCE_RANGE_TOO_LONG",
      "Khoảng ngày tối đa 366 ngày.",
    );
}

export class FinanceReports {
  constructor(book) {
    this.book = book;
  }

  summary(query) {
    return this.book.read(async (settings, session) => {
      const { from, to } = financeRange(settings, query);
      const openingBalance =
        settings.openingBalance +
        change(await this.book.totalsBefore(from, session));
      const breakdown = await this.book.entries
        .aggregate([
          { $match: { status: "POSTED", businessDate: dateFilter(from, to) } },
          { $group: { _id: "$category", ...totalsGroup } },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              category: "$_id",
              totalIncome: 1,
              totalExpense: 1,
            },
          },
        ])
        .session(session);
      const totals = emptyTotals();
      for (const item of breakdown) {
        totals.totalIncome += item.totalIncome;
        totals.totalExpense += item.totalExpense;
      }
      return {
        data: {
          from,
          to,
          openingBalance,
          ...totals,
          closingBalance: openingBalance + change(totals),
          breakdown,
        },
      };
    });
  }

  async dailyRows(settings, { from, to }, query, session) {
    const match = {
      $and: [
        { $eq: ["$status", "POSTED"] },
        ...(query.type ? [{ $eq: ["$type", query.type] }] : []),
        ...(query.q
          ? [
              {
                $regexMatch: {
                  input: "$content",
                  regex: contentPattern(query.q),
                  options: "i",
                },
              },
            ]
          : []),
      ],
    };
    const rows = await this.book.entries
      .aggregate([
        { $match: { businessDate: dateFilter(from, to) } },
        { $set: { matchesFilter: match } },
        {
          $group: {
            _id: "$businessDate",
            totalIncome: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "POSTED"] },
                      { $eq: ["$type", "INCOME"] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            totalExpense: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "POSTED"] },
                      { $eq: ["$type", "EXPENSE"] },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },
            transactionCount: {
              $sum: { $cond: [{ $eq: ["$status", "POSTED"] }, 1, 0] },
            },
            activityCount: { $sum: 1 },
            matchingTransactionCount: {
              $sum: { $cond: ["$matchesFilter", 1, 0] },
            },
            summaries: {
              $topN: {
                n: 3,
                sortBy: { matchesFilter: -1, ...entryOrder },
                output: {
                  $cond: [
                    "$matchesFilter",
                    { $substrCP: ["$content", 0, 135] },
                    null,
                  ],
                },
              },
            },
          },
        },
      ])
      .session(session);
    const closes = await this.book.closes
      .find({ _id: dateFilter(from, to) })
      .session(session)
      .lean();
    const byDate = new Map(rows.map((row) => [row._id, row]));
    const closedByDate = new Map(closes.map((row) => [row._id, row]));
    let balance =
      settings.openingBalance +
      change(await this.book.totalsBefore(from, session));
    const days = [];
    for (let date = from; date <= to; date = nextFinanceDay(date)) {
      const row = byDate.get(date);
      const close = closedByDate.get(date);
      const openingBalance = balance;
      balance += change(row ?? emptyTotals());
      const status =
        settings.closedThrough && date <= settings.closedThrough
          ? "CLOSED"
          : "OPEN";
      const filtered = Boolean(query.type || query.q);
      if (
        (query.status && status !== query.status) ||
        (filtered
          ? !row?.matchingTransactionCount
          : !row && !close && !query.includeEmpty)
      )
        continue;
      days.push({
        businessDate: date,
        openingBalance: close?.openingBalance ?? openingBalance,
        totalIncome: close?.totalIncome ?? row?.totalIncome ?? 0,
        totalExpense: close?.totalExpense ?? row?.totalExpense ?? 0,
        closingBalance: close?.closingBalance ?? balance,
        contentSummary: row?.summaries.filter(Boolean).join("; ") ?? "",
        status,
        transactionCount: row?.transactionCount ?? 0,
        activityCount: row?.activityCount ?? 0,
        matchingTransactionCount: row?.matchingTransactionCount ?? 0,
        closedBy: close?.closedBy ?? null,
        closedAt: close?.closedAt ?? null,
      });
    }
    return days;
  }

  daily(query) {
    return this.book.read(async (settings, session) => {
      const range = financeRange(settings, query);
      limitRange(range.from, range.to);
      const rows = (
        await this.dailyRows(settings, range, query, session)
      ).reverse();
      const offset = (query.page - 1) * query.limit;
      return {
        ...pageResult(
          rows.slice(offset, offset + query.limit),
          query,
          rows.length,
        ),
        ...range,
      };
    });
  }

  day(date, query) {
    return this.book.read(async (settings, session) => {
      requireBookDate(settings, date);
      const [daily] = await this.dailyRows(
        settings,
        { from: date, to: date },
        { includeEmpty: true },
        session,
      );
      const filter = { businessDate: date, ...displayedEntry(query) };
      const total = await this.book.entries
        .countDocuments(filter)
        .session(session);
      const rows = await this.book.entries
        .find(filter)
        .sort(entryOrder)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .session(session)
        .lean();
      const reversals = rows.length
        ? await this.book.entries
            .find({
              reversalOf: { $in: rows.map((row) => row._id), $type: "string" },
            })
            .select("_id reversalOf businessDate")
            .session(session)
            .lean()
        : [];
      const reversalByEntry = new Map(
        reversals.map((row) => [
          row.reversalOf,
          { id: row._id, businessDate: row.businessDate },
        ]),
      );
      const entries = pageResult(
        rows.map((row) => ({
          ...presentEntry(row),
          reversal: reversalByEntry.get(row._id) ?? null,
        })),
        query,
        total,
      );
      return {
        data: {
          ...daily,
          transactions: entries.data,
          pagination: entries.pagination,
        },
      };
    });
  }

  export(query) {
    return this.book.read(async (settings, session) => {
      const range = financeRange(settings, query);
      limitRange(range.from, range.to);
      const filter = { businessDate: dateFilter(range.from, range.to) };
      const count = await this.book.entries
        .countDocuments(filter)
        .session(session);
      if (count > 10000)
        throw financeError(
          422,
          "FINANCE_EXPORT_LIMIT",
          "Mỗi lần xuất tối đa 10.000 phiếu. Hãy chọn khoảng ngày ngắn hơn.",
        );
      const days = await this.dailyRows(
        settings,
        range,
        { includeEmpty: true },
        session,
      );
      const entries = await this.book.entries
        .find(filter)
        .select("-attachments")
        .sort({ businessDate: 1, ...entryOrder })
        .session(session)
        .lean();
      return { ...range, days, entries };
    });
  }
}
