import { id, hash, owns, fail, ok } from "./tradeShared.js";
export class TradeAnalyticsService {
  constructor(core) {
    this.core = core;
  }
  async record(post, type, actor, context = {}) {
    const c = this.core;
    try {
      const visitorHash =
        context.ip || context.userAgent
          ? hash(
              c.secret +
                "|" +
                (context.ip || "") +
                "|" +
                (context.userAgent || ""),
            )
          : null;
      await c.events.insertOne({
        _id: id(),
        tradePostId: post._id,
        type,
        userId: actor?.id || null,
        visitorHash,
        createdAt: new Date(),
      });
      if (type === "VIEW")
        await c.posts.updateOne({ _id: post._id }, { $inc: { viewCount: 1 } });
    } catch {
      console.warn("[Trade] Không ghi được thống kê tương tác.");
    }
  }
  async summary(query, actor, postId, admin = false) {
    const c = this.core;
    const to = query.to ? new Date(query.to) : new Date(),
      from = query.from
        ? new Date(query.from)
        : new Date(to.getTime() - 30 * 86400000);
    if (from > to || to - from > 366 * 86400000)
      fail(400, "VALIDATION_ERROR", "Khoảng thống kê cần từ 0 đến 366 ngày.");
    const filter = { deletedAt: null, ...(admin ? {} : { ownerId: actor.id }) };
    let post;
    if (postId) {
      post = await c.posts.findOne({ _id: postId, deletedAt: null });
      if (!post) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tin.");
      owns(actor, post.ownerId);
      filter._id = postId;
    }
    const posts = await c.posts
      .find(filter, {
        projection: { _id: 1, title: 1, slug: 1, viewCount: 1, saveCount: 1 },
      })
      .toArray();
    const postIds = posts.map((p) => p._id);
    const match = {
      tradePostId: { $in: postIds },
      createdAt: { $gte: from, $lte: to },
    };
    const [result] = await c.events
      .aggregate([
        { $match: match },
        {
          $facet: {
            totals: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
            unique: [
              {
                $match: {
                  type: "VIEW",
                  $or: [
                    { userId: { $ne: null } },
                    { visitorHash: { $ne: null } },
                  ],
                },
              },
              { $group: { _id: { $ifNull: ["$userId", "$visitorHash"] } } },
              { $count: "count" },
            ],
            timeseries: [
              {
                $group: {
                  _id: {
                    day: {
                      $dateToString: {
                        date: "$createdAt",
                        format: "%Y-%m-%d",
                        timezone: "Asia/Ho_Chi_Minh",
                      },
                    },
                    type: "$type",
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { "_id.day": 1 } },
            ],
            top: [
              { $match: { type: "VIEW" } },
              { $group: { _id: "$tradePostId", views: { $sum: 1 } } },
              { $sort: { views: -1, _id: 1 } },
              { $limit: 5 },
            ],
          },
        },
      ])
      .toArray();
    const value = (type) =>
      result?.totals.find((r) => r._id === type)?.count || 0;
    const reviews = await c.reviews
      .aggregate([
        {
          $match: {
            tradePostId: { $in: postIds },
            status: "PUBLISHED",
            deletedAt: null,
            createdAt: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            averageRating: { $avg: "$rating" },
          },
        },
      ])
      .toArray();
    const series = new Map();
    for (const row of result?.timeseries || []) {
      const day = series.get(row._id.day) || {
        date: row._id.day,
        views: 0,
        contactPhone: 0,
        contactZalo: 0,
        share: 0,
        save: 0,
      };
      day[
        {
          VIEW: "views",
          CONTACT_PHONE: "contactPhone",
          CONTACT_ZALO: "contactZalo",
          SHARE: "share",
          SAVE: "save",
        }[row._id.type]
      ] = row.count;
      series.set(row._id.day, day);
    }
    return ok({
      range: { from, to },
      postCount: posts.length,
      totals: {
        views: value("VIEW"),
        uniqueVisitors: result?.unique[0]?.count || 0,
        contactPhone: value("CONTACT_PHONE"),
        contactZalo: value("CONTACT_ZALO"),
        share: value("SHARE"),
        save: value("SAVE"),
      },
      reviews: {
        count: reviews[0]?.count || 0,
        averageRating: Math.round((reviews[0]?.averageRating || 0) * 10) / 10,
      },
      topPosts: (result?.top || []).map((row) => ({
        id: row._id,
        title: posts.find((p) => p._id === row._id)?.title,
        views: row.views,
      })),
      timeseries: [...series.values()],
      ...(post
        ? {
            post: {
              id: post._id,
              title: post.title,
              viewCount: post.viewCount,
              saveCount: post.saveCount,
            },
          }
        : {}),
    });
  }
}
