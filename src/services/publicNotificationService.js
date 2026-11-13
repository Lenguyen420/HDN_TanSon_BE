// Public inbox entries are derived from public content, never from private
// registration receipts or trade notifications. Stable IDs preserve read state.
export class PublicNotificationService {
  constructor(content) {
    this.content = content;
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
    for (const source of ["news", "events"])
      pipeline.push({
        $unionWith: {
          coll: this.content[source].model.collection.name,
          pipeline: this.pipeline(source),
        },
      });
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
      data: result.data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total[0]?.count ?? 0,
      },
    };
  }
}
