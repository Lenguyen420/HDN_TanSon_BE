import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../utils/httpError.js";
import { eventSchedule, participationStatus } from "./eventSchedule.js";
const digest = (token) => createHash("sha256").update(token).digest("hex");
const present = (row) => ({
  id: row._id,
  eventId: row.eventId,
  name: row.name,
  company: row.company,
  checkedAt: row.checkedAt || null,
  registeredAt: row.registeredAt || null,
});
const today = (now) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
export class EventAttendanceService {
  constructor(records, events, clock = () => new Date()) {
    this.records = records;
    this.events = events;
    this.clock = clock;
  }
  async status(eventId, token) {
    await this.events.get(eventId, true);
    const record = await this.records
      .findOne({ eventId, tokenHash: digest(token) })
      .lean();
    return { data: record?.checkedAt ? present(record) : null };
  }
  async join(eventId, dto) {
    const article = await this.events.get(eventId, true);
    const now = this.clock();
    const schedule = eventSchedule(article);
    const filter = { eventId, tokenHash: digest(dto.token) };
    const existing = await this.records.findOne(filter).lean();
    if (existing?.registeredAt)
      return {
        data: {
          ...present(existing),
          status: participationStatus(existing, article, now),
        },
      };
    if (!schedule)
      throw new HttpError(
        409,
        "Sự kiện chưa có đủ giờ bắt đầu và kết thúc. Vui lòng liên hệ Ban tổ chức.",
      );
    if (now >= schedule.start)
      throw new HttpError(
        409,
        "Đăng ký tham gia đã đóng vì sự kiện đã bắt đầu.",
      );
    let record;
    try {
      record = await this.records
        .findOneAndUpdate(
          { ...filter, registeredAt: null },
          {
            $set: { registeredAt: now, name: dto.name, company: dto.company },
            $setOnInsert: { ...filter, _id: randomUUID() },
          },
          { upsert: true, new: true, runValidators: true },
        )
        .lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await this.records.findOne(filter).lean();
    }
    return {
      data: {
        ...present(record),
        status: participationStatus(record, article, now),
      },
    };
  }
  async checkIn(eventId, dto) {
    const article = await this.events.get(eventId, true);
    const filter = { eventId, tokenHash: digest(dto.token) };
    const existing = await this.records.findOne(filter).lean();
    if (existing?.checkedAt) return { data: present(existing) };
    const now = this.clock();
    const schedule = eventSchedule(article);
    if (
      !article.event?.checkInEnabled ||
      article.event.date !== today(now) ||
      (schedule && now >= schedule.end)
    )
      throw new HttpError(
        409,
        "Sự kiện chưa mở điểm danh hoặc đã hết thời gian điểm danh.",
      );
    let record;
    try {
      record = await this.records
        .findOneAndUpdate(
          { ...filter, checkedAt: null },
          {
            $set: { checkedAt: now },
            $setOnInsert: {
              ...filter,
              _id: randomUUID(),
              name: dto.name,
              company: dto.company,
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
    const article = await this.events.get(eventId);
    const [rows, total] = await Promise.all([
      this.records
        .find({ eventId })
        .sort({ registeredAt: -1, checkedAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.records.countDocuments({ eventId }),
    ]);
    return {
      data: rows.map((row) => ({
        ...present(row),
        status: participationStatus(row, article, this.clock()),
      })),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async updates(tokens) {
    if (!tokens.length) return { data: [], participations: [] };
    const now = this.clock();
    const rows = await this.records
      .find({
        $or: tokens.map(({ eventId, token }) => ({
          eventId,
          tokenHash: digest(token),
        })),
      })
      .lean();
    const articles = await this.events.model
      .find({
        _id: { $in: rows.map((row) => row.eventId) },
        deletedAt: null,
        ...this.events.publicFilter(),
      })
      .lean();
    const data = [],
      participations = [];
    for (const row of rows) {
      const article = articles.find((item) => item._id === row.eventId);
      if (!article) continue;
      participations.push({
        ...present(row),
        status: participationStatus(row, article, now),
      });
      const schedule = eventSchedule(article);
      if (!row.registeredAt || !schedule) continue;
      const reminderAt = new Date(
        Math.max(
          schedule.remindAt.getTime(),
          new Date(row.registeredAt).getTime(),
        ),
      );
      if (now < reminderAt || new Date(row.registeredAt) >= schedule.start)
        continue;
      const description =
        article.title +
        " bắt đầu lúc " +
        article.event.time +
        " ngày " +
        article.event.date +
        " tại " +
        article.event.venue +
        ". Vui lòng tham dự và điểm danh.";
      data.push({
        id: "event-reminder-" + row._id + "-" + schedule.start.getTime(),
        title: "Nhắc lịch sự kiện đã đăng ký",
        description,
        paragraphs: [description],
        category: "Nhắc lịch sự kiện",
        date: today(reminderAt),
        time: reminderAt.toLocaleTimeString("en-GB", {
          timeZone: "Asia/Ho_Chi_Minh",
          hour: "2-digit",
          minute: "2-digit",
        }),
        createdAt: reminderAt.toISOString(),
        unread: true,
        related: { category: "events", articleId: row.eventId },
      });
    }
    return {
      data: data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      participations,
    };
  }
  async adminInbox(query) {
    const now = this.clock();
    const rows = await this.records
      .find({ registeredAt: { $ne: null }, checkedAt: null })
      .lean();
    const articles = await this.events.model
      .find({
        _id: { $in: rows.map((row) => row.eventId) },
        deletedAt: null,
        ...this.events.publicFilter(),
      })
      .lean();
    const notices = [];
    for (const row of rows) {
      const article = articles.find((item) => item._id === row.eventId);
      if (!article || participationStatus(row, article, now) !== "absent")
        continue;
      const schedule = eventSchedule(article);
      notices.push({
        id: "event-absent-" + row._id + "-" + schedule.end.getTime(),
        eventId: row.eventId,
        title: "Vắng mặt tại sự kiện",
        description:
          row.name +
          (row.company ? " — " + row.company : "") +
          " đã đăng ký nhưng chưa điểm danh: " +
          article.title,
        participantName: row.name,
        company: row.company,
        status: "absent",
        createdAt: schedule.end.toISOString(),
        href: "/admin/events",
      });
    }
    notices.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
    return {
      data: notices.slice(
        (query.page - 1) * query.limit,
        query.page * query.limit,
      ),
      absentCount: notices.length,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: notices.length,
      },
    };
  }
}
