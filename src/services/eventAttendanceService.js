import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
const digest = (token) => createHash("sha256").update(token).digest("hex");
const present = (row) => ({
  id: row._id,
  eventId: row.eventId,
  name: row.name,
  company: row.company,
  checkedAt: row.checkedAt,
});
export class EventAttendanceService {
  constructor(records, events) {
    this.records = records;
    this.events = events;
  }
  async status(eventId, token) {
    await this.events.get(eventId, true);
    const record = await this.records
      .findOne({ eventId, tokenHash: digest(token) })
      .lean();
    return { data: record ? present(record) : null };
  }
  async checkIn(eventId, dto) {
    const article = await this.events.get(eventId, true);
    const filter = { eventId, tokenHash: digest(dto.token) };
    const existing = await this.records.findOne(filter).lean();
    if (existing) return { data: present(existing) };
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    if (!article.event?.checkInEnabled || article.event.date !== today)
      throw new HttpError(
        409,
        "Sự kiện chưa mở điểm danh hoặc không diễn ra hôm nay.",
      );
    let record;
    try {
      record = await this.records
        .findOneAndUpdate(
          filter,
          {
            $setOnInsert: {
              ...filter,
              _id: randomUUID(),
              name: dto.name,
              company: dto.company,
              checkedAt: new Date(),
            },
          },
          { upsert: true, new: true, runValidators: true },
        )
        .lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await this.records.findOne(filter).lean();
    }
    return { data: present(record) };
  }
  async list(eventId, query) {
    await this.events.get(eventId);
    const [rows, total] = await Promise.all([
      this.records
        .find({ eventId })
        .sort({ checkedAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.records.countDocuments({ eventId }),
    ]);
    return {
      data: rows.map(present),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
}
