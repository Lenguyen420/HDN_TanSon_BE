import { createHash } from "node:crypto";
import { companyAnniversaryPipeline } from "./companyAnniversary.js";
import { publicExpiry } from "./tradeShared.js";
// Public inbox entries are derived from public content, never from private
// registration receipts or trade notifications. Stable IDs preserve read state.
export class PublicNotificationService {
  constructor(content, members, clock = () => new Date(), trade) {
    this.content = content;
    this.members = members;
    this.clock = clock;
    this.trade = trade;
  }
  tradePipeline() {
    return [
      {
        $match: {
          status: "PUBLISHED",
          deletedAt: null,
          publishedAt: { $ne: null },
          ...publicExpiry(),
        },
      },
      {
        $lookup: {
          from: this.trade.categories.collectionName,
          localField: "categoryId",
          foreignField: "_id",
          as: "tradeCategory",
        },
      },
      {
        $match: {
          tradeCategory: { $elemMatch: { isActive: true, deletedAt: null } },
        },
      },
      {
        $project: {
          _id: 0,
          id: { $concat: ["trade-post-new-", "$_id"] },
          title: { $concat: ["Tin giao thương mới: ", "$title"] },
          description: "$summary",
          paragraphs: ["$summary"],
          category: { $literal: "Giao thương" },
          scope: { $literal: "public" },
          source: { $literal: "trade" },
          date: {
            $dateToString: {
              date: "$publishedAt",
              format: "%Y-%m-%d",
              timezone: "Asia/Ho_Chi_Minh",
            },
          },
          time: {
            $dateToString: {
              date: "$publishedAt",
              format: "%H:%M",
              timezone: "Asia/Ho_Chi_Minh",
            },
          },
          createdAt: "$publishedAt",
          image: { $ifNull: ["$thumbnailUrl", ""] },
          tradePostId: "$_id",
        },
      },
    ];
  }
  pipeline(source) {
    const service = this.content[source];
    const announcement = source === "notifications";
    return [
      { $match: { deletedAt: null, ...service.publicFilter() } },
      {
        $project: {
          _id: 0,
          id: announcement
            ? "$_id"
            : { $concat: [`content-${source}-`, "$_id"] },
          title: announcement
            ? "$title"
            : {
                $concat: [
                  source === "news" ? "Tin tức mới: " : "Sự kiện mới: ",
                  "$title",
                ],
              },
          description: announcement ? "$description" : "$summary",
          paragraphs: announcement ? "$paragraphs" : ["$summary"],
          category: announcement
            ? "$category"
            : { $literal: source === "news" ? "Tin tức" : "Sự kiện" },
          date: announcement ? "$date" : "$publishedAt",
          time: announcement ? { $ifNull: ["$time", ""] } : { $literal: "" },
          createdAt: 1,
          image: { $ifNull: ["$image", ""] },
          scope: { $literal: "public" },
          source: { $literal: announcement ? "announcement" : source },
          ...(announcement
            ? {}
            : {
                related: { category: { $literal: source }, articleId: "$_id" },
              }),
        },
      },
    ];
  }
  async list(query) {
    const pipeline = this.pipeline("notifications");
    if (this.trade)
      pipeline.push({
        $unionWith: {
          coll: this.trade.posts.collectionName,
          pipeline: this.tradePipeline(),
        },
      });
    for (const source of ["news", "events"])
      pipeline.push({
        $unionWith: {
          coll: this.content[source].model.collection.name,
          pipeline: this.pipeline(source),
        },
      });
    if (this.members) {
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(this.clock());
      pipeline.push({
        $unionWith: {
          coll: this.members.collection.name,
          pipeline: companyAnniversaryPipeline(date),
        },
      });
    }
    if (query.source) pipeline.push({ $match: { source: query.source } });
    if (query.search) {
      const search = {
        $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
      pipeline.push({
        $match: { $or: [{ title: search }, { description: search }] },
      });
    }
    pipeline.push(
      { $sort: { date: -1, time: -1, createdAt: -1, id: 1 } },
      {
        $facet: {
          data: [
            { $skip: (query.page - 1) * query.limit },
            { $limit: query.limit },
          ],
          total: [{ $count: "count" }],
        },
      },
    );
    const [result] = await this.content.notifications.model.aggregate(pipeline);
    return {
      data: result.data.map((notice) =>
        notice.source === "company-anniversary"
          ? {
              ...notice,
              id:
                "company-anniversary-" +
                createHash("sha256").update(notice.id).digest("hex"),
            }
          : notice,
      ),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total[0]?.count ?? 0,
      },
    };
  }
}
