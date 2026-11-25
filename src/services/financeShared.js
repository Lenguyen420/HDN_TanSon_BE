import { HttpError } from "../utils/httpError.js";

export const financeTimeZone = "Asia/Ho_Chi_Minh";
export const maxLedgerTotal = 999_999_999_999_999;
const dayMillis = 86_400_000;
export const financeToday = (at = new Date()) =>
  at.toLocaleDateString("en-CA", { timeZone: financeTimeZone });
export const nextFinanceDay = (date) =>
  new Date(Date.parse(date) + dayMillis).toISOString().slice(0, 10);
export const countDays = (from, to) =>
  (Date.parse(to) - Date.parse(from)) / dayMillis + 1;

export function financeError(status, code, message) {
  return Object.assign(new HttpError(status, message), { code });
}
export const requireOpening = (settings) => {
  if (!settings.openingDate)
    throw financeError(
      409,
      "FINANCE_NOT_INITIALIZED",
      "Cần thiết lập số dư ban đầu trước khi sử dụng sổ quỹ.",
    );
};
export function requireBookDate(settings, date) {
  requireOpening(settings);
  if (date < settings.openingDate || date > financeToday())
    throw financeError(
      422,
      "FINANCE_DATE_OUT_OF_RANGE",
      "Ngày phát sinh phải từ ngày mở sổ đến hôm nay.",
    );
}
export function requireOpenDate(settings, date) {
  requireBookDate(settings, date);
  if (settings.closedThrough && date <= settings.closedThrough)
    throw financeError(409, "FINANCE_DATE_CLOSED", "Ngày đã chốt sổ.");
}
export function financeRange(settings, query) {
  requireOpening(settings);
  const today = financeToday();
  const to = query.to ?? today;
  const requestedFrom = query.from ?? to.slice(0, 7) + "-01";
  if (requestedFrom > to || to > today)
    throw financeError(
      422,
      "FINANCE_DATE_OUT_OF_RANGE",
      "Khoảng ngày không hợp lệ hoặc vượt quá hôm nay.",
    );
  const from =
    requestedFrom < settings.openingDate ? settings.openingDate : requestedFrom;
  requireBookDate(settings, from);
  if (to < from)
    throw financeError(
      422,
      "FINANCE_DATE_OUT_OF_RANGE",
      "Khoảng ngày nằm trước ngày mở sổ.",
    );
  return { from, to };
}
export const totalsGroup = {
  totalIncome: {
    $sum: { $cond: [{ $eq: ["$type", "INCOME"] }, "$amount", 0] },
  },
  totalExpense: {
    $sum: { $cond: [{ $eq: ["$type", "EXPENSE"] }, "$amount", 0] },
  },
};
export const emptyTotals = () => ({ totalIncome: 0, totalExpense: 0 });
export const change = ({ totalIncome, totalExpense }) =>
  totalIncome - totalExpense;
export const effect = ({ type, amount }) =>
  type === "INCOME" ? amount : -amount;
export const contentPattern = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function presentEntry({ _id, ...entry }) {
  const id = String(_id);
  return {
    id,
    ...entry,
    attachments: (entry.attachments ?? []).map((file) => ({
      ...file,
      url: `/api/v1/admin/finance/transactions/${id}/attachments/${file.id}`,
    })),
  };
}
export function pageResult(data, query, total) {
  return { data, pagination: { page: query.page, limit: query.limit, total } };
}
export const entryOrder = { createdAt: 1, _id: 1 };
