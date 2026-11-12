import {
  id,
  fail,
  staff,
  seller,
  owns,
  present,
  page,
  ok,
} from "./tradeShared.js";
export class TradeCommunityService {
  constructor(core) {
    this.core = core;
  }
  async save(value, actor, remove = false, context = {}) {
    const c = this.core;
    const result = await c.tx(async (session) => {
      const visible = remove
        ? await c.posts.findOne(
            { $or: [{ _id: value }, { slug: value }] },
            { session },
          )
        : await c.publicPost(value, session);
      if (!visible)
        fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tin giao thương.");
      const post = await c.lockedPost(visible._id, session);
      const filter = { userId: actor.id, tradePostId: post._id };
      let fresh = false;
      if (remove) await c.saves.deleteOne(filter, { session });
      else {
        const saved = await c.saves.updateOne(
          filter,
          { $setOnInsert: { _id: id(), ...filter, createdAt: new Date() } },
          { session, upsert: true },
        );
        fresh = saved.upsertedCount > 0;
      }
      const saveCount = await c.saves.countDocuments(
        { tradePostId: post._id },
        { session },
      );
      await c.posts.updateOne(
        { _id: post._id },
        { $set: { saveCount } },
        { session },
      );
      return { post, fresh, saveCount };
    });
    if (result.fresh) {
      await c.notify(
        "TRADE_POST_SAVED",
        result.post,
        {},
        { userId: result.post.ownerId },
      );
      await c.analytics.record(result.post, "SAVE", actor, context);
    }
    return ok({ saved: !remove, saveCount: result.saveCount });
  }
  async ratings(postId, session) {
    const c = this.core;
    const [summary] = await c.reviews
      .aggregate(
        [
          {
            $match: {
              tradePostId: postId,
              status: "PUBLISHED",
              deletedAt: null,
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              average: { $avg: "$rating" },
            },
          },
        ],
        { session },
      )
      .toArray();
    await c.posts.updateOne(
      { _id: postId },
      {
        $set: {
          averageRating: Math.round((summary?.average || 0) * 10) / 10,
          reviewCount: summary?.count || 0,
        },
      },
      { session },
    );
  }
  async reviewList(query, actor, scope = "public", postId) {
    const c = this.core,
      filter = { deletedAt: null };
    if (scope === "author") {
      filter.userId = actor.id;
      if (query.tradePostId) filter.tradePostId = query.tradePostId;
    }
    if (scope === "public") {
      await c.publicPost(postId);
      filter.tradePostId = postId;
      filter.status = "PUBLISHED";
    }
    if (scope === "seller") {
      seller(actor);
      const posts = await c.posts
        .find(
          { ownerId: actor.id, deletedAt: null },
          { projection: { _id: 1 } },
        )
        .toArray();
      filter.tradePostId = { $in: posts.map((p) => p._id) };
    }
    if (scope !== "public" && query.tradePostId) {
      if (scope === "seller") {
        const owned = await c.posts.findOne({
          _id: query.tradePostId,
          ownerId: actor.id,
          deletedAt: null,
        });
        if (!owned) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tin.");
      }
      filter.tradePostId = query.tradePostId;
    }
    if (scope !== "public" && query.status) filter.status = query.status;
    const [rows, total] = await Promise.all([
      c.reviews
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      c.reviews.countDocuments(filter),
    ]);
    const [users, posts, replies] = await Promise.all([
      c.auth.users
        .find(
          { _id: { $in: rows.map((row) => row.userId) } },
          { projection: { displayName: 1, avatarUrl: 1 } },
        )
        .toArray(),
      c.posts
        .find(
          { _id: { $in: rows.map((row) => row.tradePostId) } },
          { projection: { title: 1, ownerId: 1 } },
        )
        .toArray(),
      c.customer_replies
        .find({ reviewId: { $in: rows.map((row) => row._id) } })
        .sort({ createdAt: 1, _id: 1 })
        .toArray(),
    ]);
    const usersById = new Map(users.map((user) => [user._id, user])),
      postsById = new Map(posts.map((post) => [post._id, post]));
    const data = rows.map((row) => {
      const user = usersById.get(row.userId);
      return {
        ...present(row),
        user: user
          ? {
              id: user._id,
              displayName: user.displayName,
              avatarUrl: user.avatarUrl,
            }
          : null,
        post: present(postsById.get(row.tradePostId)),
        replies: replies
          .filter((reply) => reply.reviewId === row._id)
          .map(present),
        isAuthor: actor?.id === row.userId,
      };
    });
    return { ...page([], total, query), data };
  }
  async summary(postId) {
    const c = this.core;
    await c.publicPost(postId);
    const rows = await c.reviews
      .aggregate([
        {
          $match: { tradePostId: postId, status: "PUBLISHED", deletedAt: null },
        },
        { $group: { _id: "$rating", count: { $sum: 1 } } },
      ])
      .toArray();
    const counts = Object.fromEntries(
      [1, 2, 3, 4, 5].map((r) => [
        r,
        rows.find((x) => x._id === r)?.count || 0,
      ]),
    );
    const count = Object.values(counts).reduce((a, b) => a + b, 0);
    return ok({
      count,
      averageRating: count
        ? Math.round(
            (Object.entries(counts).reduce(
              (s, [r, n]) => s + Number(r) * n,
              0,
            ) /
              count) *
              10,
          ) / 10
        : 0,
      counts,
    });
  }
  async createReview(postId, dto, actor) {
    const c = this.core;
    let result;
    try {
      result = await c.tx(async (session) => {
        const post = await c.lockedPost(postId, session);
        if (post.status !== "PUBLISHED")
          fail(404, "RESOURCE_NOT_FOUND", "Tin chưa được công bố.");
        const owner = await c.auth.users.findOne(
          { _id: post.ownerId },
          { session },
        );
        if (
          post.ownerId === actor.id ||
          (actor.memberId &&
            actor.memberId === (post.ownerMemberId || owner?.memberId))
        )
          fail(
            403,
            "TRADE_POST_OWNER_CANNOT_REVIEW",
            "Doanh nghiệp không được tự đánh giá tin của mình.",
          );
        if (
          await c.reviews.findOne(
            { tradePostId: postId, userId: actor.id, deletedAt: null },
            { session },
          )
        )
          fail(409, "REVIEW_ALREADY_EXISTS", "Bạn đã đánh giá tin này.");
        const reviewId = id();
        const images = await c.images(
          dto.imageIds || [],
          actor.id,
          "review:" + reviewId,
          session,
        );
        const row = {
          _id: reviewId,
          tradePostId: postId,
          userId: actor.id,
          ...dto,
          imageIds: dto.imageIds || [],
          images,
          status: "PUBLISHED",
          replyContent: null,
          repliedAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await c.reviews.insertOne(row, { session });
        await this.ratings(postId, session);
        return { post, row };
      });
    } catch (e) {
      if (e.code === 11000)
        fail(409, "REVIEW_ALREADY_EXISTS", "Bạn đã đánh giá tin này.");
      throw e;
    }
    await c.notify(
      "TRADE_REVIEW_RECEIVED",
      result.post,
      { reviewId: result.row._id },
      { userId: result.post.ownerId },
    );
    await c.notify(
      "TRADE_REVIEW_SUBMITTED",
      result.post,
      {
        reviewId: result.row._id,
        excludeUserIds: [actor.id, result.post.ownerId],
      },
      { staff: true },
    );
    return ok(present(result.row));
  }
  async changeReview(reviewId, dto, actor, action = "edit") {
    const c = this.core;
    const result = await c.tx(async (session) => {
      const old = await c.reviews.findOne(
        { _id: reviewId, deletedAt: null },
        { session },
      );
      if (!old) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy đánh giá.");
      const post = await c.lockedPost(old.tradePostId, session);
      if (action === "status") {
        if (!staff(actor))
          fail(403, "STAFF_REQUIRED", "Chỉ Ban quản trị Hội được kiểm duyệt.");
      } else if (action === "delete") owns(actor, old.userId);
      else if (actor.id !== old.userId)
        fail(403, "RESOURCE_FORBIDDEN", "Chỉ người viết được sửa đánh giá.");
      const changes =
        action === "delete"
          ? { deletedAt: new Date() }
          : action === "status"
            ? { status: dto.status }
            : { ...dto };
      const newIds =
        action === "delete" ? [] : (dto.imageIds ?? old.imageIds ?? []);
      const removed = await c.releaseImages(
        old.imageIds || [],
        newIds,
        "review:" + reviewId,
        session,
      );
      if (action === "edit" && dto.imageIds)
        changes.images = await c.images(
          newIds,
          old.userId,
          "review:" + reviewId,
          session,
        );
      changes.updatedAt = new Date();
      await c.reviews.updateOne(
        { _id: reviewId },
        { $set: changes },
        { session },
      );
      await this.ratings(post._id, session);
      const row = { ...old, ...changes };
      if (staff(actor) && action !== "edit")
        await c.auditEntry(
          actor,
          action === "delete"
            ? "TRADE_REVIEW_DELETE"
            : "TRADE_REVIEW_" + dto.status,
          "TradeReview",
          reviewId,
          present(old),
          present(row),
          session,
        );
      return { old, row, post, removed };
    });
    if (
      staff(actor) &&
      (action === "delete" ||
        (action === "status" && result.old.status !== dto.status))
    )
      await c.notify(
        action === "delete"
          ? "TRADE_REVIEW_DELETED"
          : dto.status === "PUBLISHED"
            ? "TRADE_REVIEW_APPROVED"
            : "TRADE_REVIEW_HIDDEN",
        result.post,
        { reviewId },
        { userId: result.row.userId },
      );
    await c.mediaService.cleanup(result.removed);
    return ok(present(result.row));
  }
  async reviewImage(reviewId, mediaId, actor, remove = false) {
    // The post lock in changeReview serializes replacement. Include an explicit
    // transaction here so simultaneous additions cannot overwrite each other.
    const c = this.core;
    const result = await c.tx(async (session) => {
      const review = await c.reviews.findOne(
        { _id: reviewId, deletedAt: null },
        { session },
      );
      if (!review) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy đánh giá.");
      if (review.userId !== actor.id)
        fail(403, "RESOURCE_FORBIDDEN", "Chỉ người viết được sửa ảnh.");
      await c.lockedPost(review.tradePostId, session);
      const ids = remove
        ? (review.imageIds || []).filter((v) => v !== mediaId)
        : [...new Set([...(review.imageIds || []), mediaId])];
      if (ids.length > 3)
        fail(
          400,
          "UPLOAD_LIMIT_EXCEEDED",
          "Đánh giá chỉ được đính kèm tối đa 3 ảnh.",
        );
      const removed = await c.releaseImages(
        review.imageIds || [],
        ids,
        "review:" + reviewId,
        session,
      );
      const images = await c.images(
        ids,
        actor.id,
        "review:" + reviewId,
        session,
      );
      await c.reviews.updateOne(
        { _id: reviewId },
        { $set: { imageIds: ids, images, updatedAt: new Date() } },
        { session },
      );
      return { row: { ...review, imageIds: ids, images }, removed };
    });
    await c.mediaService.cleanup(result.removed);
    return ok(present(result.row));
  }
  async ownerReply(reviewId, content, actor) {
    seller(actor);
    const c = this.core;
    const result = await c.tx(async (session) => {
      const review = await c.reviews.findOne(
        { _id: reviewId, deletedAt: null, status: "PUBLISHED" },
        { session },
      );
      if (!review)
        fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy đánh giá công khai.");
      const post = await c.lockedPost(review.tradePostId, session);
      if (post.ownerId !== actor.id)
        fail(
          403,
          "REVIEW_REPLY_NOT_ALLOWED",
          "Chỉ doanh nghiệp chủ tin được phản hồi.",
        );
      const changes = {
        replyContent: content,
        repliedAt: content ? new Date() : null,
      };
      await c.reviews.updateOne(
        { _id: reviewId },
        { $set: changes },
        { session },
      );
      return { row: { ...review, ...changes }, post };
    });
    if (content)
      await c.notify(
        "TRADE_REVIEW_REPLIED",
        result.post,
        { reviewId },
        { userId: result.row.userId },
      );
    return ok(present(result.row));
  }
  async customerReply(reviewId, content, actor, postId) {
    const c = this.core;
    const result = await c.tx(async (session) => {
      const review = await c.reviews.findOne(
        {
          _id: reviewId,
          tradePostId: postId,
          status: "PUBLISHED",
          deletedAt: null,
        },
        { session },
      );
      if (!review) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy đánh giá.");
      const post = await c.publicPost(review.tradePostId, session);
      await c.lockedPost(post._id, session);
      if (
        post.ownerId === actor.id ||
        (actor.memberId && actor.memberId === post.ownerMemberId)
      )
        fail(
          403,
          "TRADE_REVIEW_CUSTOMER_REPLY_NOT_ALLOWED",
          "Doanh nghiệp sử dụng mục phản hồi đánh giá.",
        );
      if (!review.replyContent)
        fail(
          409,
          "TRADE_REVIEW_OWNER_REPLY_REQUIRED",
          "Doanh nghiệp chưa có phản hồi cho đánh giá này.",
        );
      const row = {
        _id: id(),
        reviewId,
        userId: actor.id,
        content,
        createdAt: new Date(),
      };
      await c.customer_replies.insertOne(row, { session });
      return row;
    });
    return ok(present(result));
  }
  async conversation(conversationId, actor, admin = false, session) {
    const row = await this.core.conversations.findOne(
      {
        _id: conversationId,
        ...(admin
          ? {}
          : { $or: [{ customerId: actor.id }, { ownerId: actor.id }] }),
      },
      { session },
    );
    if (!row) fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy hội thoại.");
    if (row.deletedAt)
      fail(410, "RESOURCE_NOT_FOUND", "Hội thoại đã được Ban quản trị đóng.");
    return row;
  }
  async openConversation(postId, content, actor) {
    const c = this.core;
    const result = await c.tx(async (session) => {
      const post = await c.publicPost(postId, session);
      await c.lockedPost(post._id, session);
      const owner = await c.auth.users.findOne(
        { _id: post.ownerId },
        { session },
      );
      if (
        post.ownerId === actor.id ||
        (actor.memberId &&
          actor.memberId === (post.ownerMemberId || owner?.memberId))
      )
        fail(
          403,
          "CANNOT_MESSAGE_OWN_POST",
          "Bạn không thể mở hội thoại với tin của mình.",
        );
      let conversation = await c.conversations.findOne(
        { tradePostId: postId, customerId: actor.id },
        { session },
      );
      const fresh = !conversation;
      if (conversation?.deletedAt)
        fail(410, "RESOURCE_NOT_FOUND", "Hội thoại đã được Ban quản trị đóng.");
      const now = new Date();
      if (!conversation) {
        conversation = {
          _id: id(),
          tradePostId: postId,
          customerId: actor.id,
          ownerId: post.ownerId,
          deletedAt: null,
          createdAt: now,
          lastMessageAt: now,
        };
        await c.conversations.insertOne(conversation, { session });
      }
      const message = {
        _id: id(),
        conversationId: conversation._id,
        senderId: actor.id,
        content,
        readAt: null,
        createdAt: now,
      };
      await c.messages.insertOne(message, { session });
      await c.conversations.updateOne(
        { _id: conversation._id },
        { $set: { lastMessageAt: now } },
        { session },
      );
      return { post, conversation, message, fresh };
    });
    if (result.fresh)
      await c.notify(
        "TRADE_CONVERSATION_STARTED",
        result.post,
        { conversationId: result.conversation._id },
        { userId: result.post.ownerId },
      );
    return ok({
      ...present(result.conversation),
      message: present(result.message),
      event: "CHAT_MESSAGE",
    });
  }
  async conversations(query, actor, admin = false) {
    const c = this.core,
      filter = {
        deletedAt: null,
        ...(admin
          ? {}
          : { $or: [{ customerId: actor.id }, { ownerId: actor.id }] }),
        ...(query.tradePostId ? { tradePostId: query.tradePostId } : {}),
      };
    const [rows, total] = await Promise.all([
      c.conversations
        .find(filter)
        .sort({ lastMessageAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      c.conversations.countDocuments(filter),
    ]);
    const [posts, users, unread] = await Promise.all([
      c.posts
        .find(
          { _id: { $in: rows.map((row) => row.tradePostId) } },
          { projection: { title: 1, thumbnailUrl: 1 } },
        )
        .toArray(),
      c.auth.users
        .find(
          {
            _id: { $in: rows.flatMap((row) => [row.customerId, row.ownerId]) },
          },
          { projection: { displayName: 1 } },
        )
        .toArray(),
      c.messages
        .aggregate([
          {
            $match: {
              conversationId: { $in: rows.map((row) => row._id) },
              senderId: { $ne: actor.id },
              readAt: null,
            },
          },
          { $group: { _id: "$conversationId", count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    const postsById = new Map(posts.map((post) => [post._id, post])),
      usersById = new Map(users.map((user) => [user._id, user])),
      unreadById = new Map(unread.map((row) => [row._id, row.count]));
    const data = rows.map((row) => ({
      ...present(row),
      post: present(postsById.get(row.tradePostId)),
      other:
        usersById.get(actor.id === row.ownerId ? row.customerId : row.ownerId)
          ?.displayName || "Hội viên",
      unreadCount: unreadById.get(row._id) || 0,
    }));
    return { ...page([], total, query), data };
  }
  async messages(conversationId, query, actor, admin = false) {
    const c = this.core;
    await this.conversation(conversationId, actor, admin);
    const filter = { conversationId };
    const [rows, total] = await Promise.all([
      c.messages
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      c.messages.countDocuments(filter),
    ]);
    return page(rows.reverse(), total, query);
  }
  async send(conversationId, content, actor) {
    const c = this.core;
    return c.tx(async (session) => {
      const conversation = await this.conversation(
        conversationId,
        actor,
        false,
        session,
      );
      await c.conversations.updateOne(
        { _id: conversationId, deletedAt: null },
        { $set: { lastMessageAt: new Date() } },
        { session },
      );
      const row = {
        _id: id(),
        conversationId,
        senderId: actor.id,
        content,
        readAt: null,
        createdAt: new Date(),
      };
      await c.messages.insertOne(row, { session });
      return ok({
        ...present(row),
        event: "CHAT_MESSAGE",
        tradePostId: conversation.tradePostId,
      });
    });
  }
  async read(conversationId, actor) {
    const c = this.core;
    await this.conversation(conversationId, actor);
    await c.messages.updateMany(
      { conversationId, senderId: { $ne: actor.id }, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return ok(true);
  }
  async deleteConversation(conversationId, actor) {
    const c = this.core;
    return c.tx(async (session) => {
      const old = await this.conversation(conversationId, actor, true, session);
      await c.conversations.updateOne(
        { _id: conversationId },
        { $set: { deletedAt: new Date() } },
        { session },
      );
      await c.auditEntry(
        actor,
        "TRADE_CONVERSATION_DELETE",
        "TradeConversation",
        conversationId,
        present(old),
        null,
        session,
      );
    });
  }
}
