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
    if (!existing?.registeredAt && !dto.name)
      throw new HttpError(
        409,
        "Chưa có đăng ký tham gia sự kiện trên thiết bị này. Vui lòng đăng ký trước khi điểm danh.",
      );
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
            ...(!existing
              ? {
                  $setOnInsert: {
                    ...filter,
                    _id: randomUUID(),
                    name: dto.name,
                    company: dto.company || "",
                  },
                }
              : {}),
          },
          { upsert: !existing, new: true, runValidators: true },
        )
        .lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await this.records.findOne(filter).lean();
    }
    // Another tap may have completed the same receipt while this request waited.
    record ??= await this.records.findOne(filter).lean();
    return { data: present(record) };
  }
  async list(eventId, query) {
    const article = eventId ? await this.events.get(eventId) : null;
    const filter = eventId ? { eventId } : {};
    const [rows, total] = await Promise.all([
      this.records
        .find(filter)
        .sort({ registeredAt: -1, checkedAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.records.countDocuments(filter),
    ]);
    const articlesById = new Map();
    if (!article && rows.length) {
      const articles = await this.events.model
        .find({ _id: { $in: [...new Set(rows.map((row) => row.eventId))] } })
        .select("title event")
        .lean();
      for (const item of articles) articlesById.set(item._id, item);
    }
    const now = this.clock();
    return {
      data: rows.map((row) => {
        const event = article || articlesById.get(row.eventId);
        return {
          ...present(row),
          ...(!eventId && { eventTitle: event?.title ?? null }),
          status: participationStatus(row, event, now),
        };
      }),
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
      .find({ registeredAt: { $ne: null } })
      .select("eventId name company registeredAt checkedAt")
      .lean();
    const articles = await this.events.model
      .find({
        _id: { $in: rows.map((row) => row.eventId) },
        deletedAt: null,
        ...this.events.publicFilter(),
      })
      .lean();
    const articlesById = new Map(articles.map((item) => [item._id, item]));
    const notices = [];
    let absentCount = 0;
    for (const row of rows) {
      const article = articlesById.get(row.eventId);
      if (!article) continue;
      const participant = row.name + (row.company ? " — " + row.company : "");
      const details = {
        eventId: row.eventId,
        participantName: row.name,
        company: row.company,
        href: "/admin/events",
      };
      notices.push({
        ...details,
        id: "event-registered-" + row._id,
        title: "Đăng ký tham gia sự kiện",
        description: participant + " đã đăng ký tham gia " + article.title + ".",
        status: "registered",
        createdAt: row.registeredAt.toISOString(),
      });
      if (participationStatus(row, article, now) !== "absent") continue;
      const schedule = eventSchedule(article);
      absentCount++;
      notices.push({
        ...details,
        id: "event-absent-" + row._id + "-" + schedule.end.getTime(),
        title: "Vắng mặt tại sự kiện",
        description:
          participant + " đã đăng ký nhưng chưa điểm danh: " + article.title,
        status: "absent",
        createdAt: schedule.end.toISOString(),
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
      absentCount,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: notices.length,
      },
    };
  }
}
