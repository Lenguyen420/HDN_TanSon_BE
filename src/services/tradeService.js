import {
  id,
  fail,
  staff,
  seller,
  owns,
  present,
  escaped,
  page,
  ok,
  expired,
  publicExpiry,
  transaction,
  allowedPurposes,
} from "./tradeShared.js";
export class TradeService {
  constructor(connection, auth, secret) {
    this.connection = connection;
    this.auth = auth;
    this.secret = secret;
    for (const name of [
      "categories",
      "posts",
      "media",
      "saves",
      "reviews",
      "customer_replies",
      "conversations",
      "messages",
      "events",
      "notifications",
      "audit",
    ])
      this[name] = connection.db.collection("trade_" + name);
  }
  async initialize() {
    await Promise.all([
      this.auth.initialize(),
      this.categories.createIndex({ code: 1 }, { unique: true }),
      this.categories.createIndex({ deletedAt: 1, isActive: 1, sortOrder: 1 }),
      this.posts.createIndex({ slug: 1 }, { unique: true }),
      this.posts.createIndex({
        deletedAt: 1,
        status: 1,
        publishedAt: -1,
        createdAt: -1,
      }),
      this.posts.createIndex({ ownerId: 1, createdAt: -1 }),
      this.posts.createIndex({ categoryId: 1 }),
      this.posts.createIndex({ featured: 1, purpose: 1 }),
      this.saves.createIndex({ userId: 1, tradePostId: 1 }, { unique: true }),
      this.reviews.createIndex(
        { tradePostId: 1, userId: 1 },
        { unique: true, partialFilterExpression: { deletedAt: null } },
      ),
      this.reviews.createIndex({ tradePostId: 1, status: 1, createdAt: -1 }),
      this.conversations.createIndex(
        { tradePostId: 1, customerId: 1 },
        { unique: true },
      ),
      this.conversations.createIndex({ ownerId: 1, lastMessageAt: -1 }),
      this.messages.createIndex({ conversationId: 1, createdAt: -1, _id: -1 }),
      this.events.createIndex({ tradePostId: 1, createdAt: 1, type: 1 }),
      this.notifications.createIndex({ createdAt: -1 }),
    ]);
  }
  tx(action) {
    return transaction(this.connection, action);
  }
  async notify(type, post, fields = {}, audience = {}) {
    try {
      await this.notifications.insertOne({
        _id: id(),
        type,
        tradePostId: post._id,
        slug: post.slug,
        title: post.title,
        ...fields,
        ...audience,
        createdAt: new Date(),
        readBy: [],
      });
    } catch {
      console.warn("[Trade] Không gửi được thông báo.");
    }
  }
  auditEntry(
    actor,
    action,
    resourceType,
    resourceId,
    oldData,
    newData,
    session,
  ) {
    return this.audit.insertOne(
      {
        _id: id(),
        actorId: actor.id,
        action,
        resourceType,
        resourceId,
        oldData,
        newData,
        createdAt: new Date(),
      },
      { session },
    );
  }
  async listCategories(admin = false) {
    return ok(
      (
        await this.categories
          .find({ deletedAt: null, ...(admin ? {} : { isActive: true }) })
          .sort({ sortOrder: 1, _id: 1 })
          .toArray()
      ).map(present),
    );
  }
  async category(code, session) {
    const category = await this.categories.findOne(
      { code, isActive: true, deletedAt: null },
      { session },
    );
    if (!category)
      fail(
        400,
        "TRADE_POST_CATEGORY_INVALID",
        "Danh mục giao thương không tồn tại hoặc đang tạm ngừng.",
      );
    return category;
  }
  async createCategory(dto, actor) {
    const last = await this.categories
      .find()
      .sort({ sortOrder: -1 })
      .limit(1)
      .next();
    const row = {
      _id: id(),
      ...dto,
      sortOrder: dto.sortOrder ?? (last?.sortOrder ?? -1) + 1,
      isActive: dto.isActive ?? true,
      requiresPromotionDetails: dto.requiresPromotionDetails ?? false,
      version: 1,
      createdById: actor.id,
      updatedById: actor.id,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    try {
      await this.categories.insertOne(row);
    } catch (e) {
      if (e.code === 11000)
        fail(409, "TRADE_POST_CATEGORY_CODE_EXISTS", "Mã danh mục đã tồn tại.");
      throw e;
    }
    return ok(present(row));
  }
  async updateCategory(categoryId, dto, actor) {
    return this.tx(async (session) => {
      const old = await this.categories.findOne(
        { _id: categoryId, deletedAt: null },
        { session },
      );
      if (!old)
        fail(404, "TRADE_POST_CATEGORY_NOT_FOUND", "Không tìm thấy danh mục.");
      const { version, ...changes } = dto;
      try {
        const row = await this.categories.findOneAndUpdate(
          { _id: categoryId, version, deletedAt: null },
          {
            $set: { ...changes, updatedById: actor.id, updatedAt: new Date() },
            $inc: { version: 1 },
          },
          { session, returnDocument: "after" },
        );
        if (!row)
          fail(
            409,
            "TRADE_POST_CATEGORY_VERSION_CONFLICT",
            "Danh mục đã được sửa. Vui lòng tải lại.",
          );
        if (changes.code && changes.code !== old.code)
          await this.posts.updateMany(
            { categoryId },
            { $set: { category: changes.code } },
            { session },
          );
        return ok(present(row));
      } catch (e) {
        if (e.code === 11000)
          fail(
            409,
            "TRADE_POST_CATEGORY_CODE_EXISTS",
            "Mã danh mục đã tồn tại.",
          );
        throw e;
      }
    });
  }
  async reorder(items, actor) {
    return this.tx(async (session) => {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        await this.updateCategoryInSession(item, index, actor, session);
      }
      return ok(true);
    });
  }
  async updateCategoryInSession(item, sortOrder, actor, session) {
    const exists = await this.categories.findOne(
      { _id: item.id, deletedAt: null },
      { session },
    );
    if (!exists)
      fail(404, "TRADE_POST_CATEGORY_NOT_FOUND", "Không tìm thấy danh mục.");
    const result = await this.categories.updateOne(
      { _id: item.id, version: item.version, deletedAt: null },
      {
        $set: { sortOrder, updatedById: actor.id, updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { session },
    );
    if (!result.matchedCount)
      fail(
        409,
        "TRADE_POST_CATEGORY_VERSION_CONFLICT",
        "Danh mục đã thay đổi. Vui lòng tải lại.",
      );
  }
  async deleteCategory(categoryId, actor) {
    return this.tx(async (session) => {
      const cat = await this.categories.findOneAndUpdate(
        { _id: categoryId, deletedAt: null },
        { $inc: { version: 1 } },
        { session, returnDocument: "after" },
      );
      if (!cat)
        fail(404, "TRADE_POST_CATEGORY_NOT_FOUND", "Không tìm thấy danh mục.");
      if (
        await this.posts.findOne({ categoryId, deletedAt: null }, { session })
      )
        fail(
          409,
          "TRADE_POST_CATEGORY_IN_USE",
          "Danh mục còn tin giao thương, chưa thể xóa.",
        );
      await this.categories.updateOne(
        { _id: categoryId },
        { $set: { deletedAt: new Date(), updatedById: actor.id } },
        { session },
      );
    });
  }
  async publicPost(value, session) {
    const post = await this.posts.findOne(
      {
        $and: [{ $or: [{ _id: value }, { slug: value }] }, publicExpiry()],
        status: "PUBLISHED",
        deletedAt: null,
      },
      { session },
    );
    if (
      !post ||
      !(await this.categories.findOne(
        { _id: post.categoryId, isActive: true, deletedAt: null },
        { session },
      ))
    )
      fail(404, "RESOURCE_NOT_FOUND", "Tin giao thương không còn hiển thị.");
    return post;
  }
  async lockedPost(value, session) {
    const post = await this.posts.findOneAndUpdate(
      { _id: value, deletedAt: null },
      { $inc: { _lock: 1 } },
      { session, returnDocument: "after" },
    );
    if (!post)
      fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tin giao thương.");
    return post;
  }
  async get(value, actor, manage = false) {
    const row = manage
      ? await this.posts.findOne({ _id: value, deletedAt: null })
      : await this.publicPost(value);
    if (!row)
      fail(404, "RESOURCE_NOT_FOUND", "Không tìm thấy tin giao thương.");
    if (manage) owns(actor, row.ownerId);
    return ok(await this.enrich(row, actor));
  }
  async enrich(row, actor) {
    const owner = await this.auth.users.findOne(
      { _id: row.ownerId },
      {
        projection: {
          displayName: 1,
          avatarUrl: 1,
          memberId: 1,
          businessType: 1,
        },
      },
    );
    const saved = actor
      ? !!(await this.saves.findOne({ userId: actor.id, tradePostId: row._id }))
      : false;
    return {
      ...present(row),
      owner: owner
        ? {
            id: owner._id,
            displayName: owner.displayName,
            avatarUrl: owner.avatarUrl,
            businessType: owner.businessType,
          }
        : null,
      saved,
      isOwner: actor?.id === row.ownerId,
    };
  }
  async list(query, actor, scope = "public") {
    const filter = { deletedAt: null };
    const clauses = [];
    if (scope === "public") {
      filter.status = "PUBLISHED";
      clauses.push(publicExpiry());
      const cats = await this.categories
        .find({ isActive: true, deletedAt: null }, { projection: { _id: 1 } })
        .toArray();
      filter.categoryId = { $in: cats.map((c) => c._id) };
    }
    if (scope === "mine") {
      seller(actor);
      filter.ownerId = actor.id;
    }
    if (query.status && scope !== "public") filter.status = query.status;
    if (query.category) {
      const cat =
        scope === "public"
          ? await this.category(query.category)
          : await this.categories.findOne({ code: query.category });
      filter.categoryId = cat?._id || "missing";
    }
    if (query.ownerId && scope !== "mine") filter.ownerId = query.ownerId;
    if (query.featured !== undefined) filter.featured = query.featured;
    if (query.purpose) filter.purpose = query.purpose;
    if (query.minPrice !== undefined || query.maxPrice !== undefined)
      filter.price = {
        ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {}),
      };
    if (query.search)
      clauses.push({
        $or: ["title", "summary", "address"].map((k) => ({
          [k]: { $regex: escaped(query.search), $options: "i" },
        })),
      });
    if (query.section) {
      const type =
        query.section === "temples"
          ? "TEMPLE_MANAGEMENT"
          : query.section === "cuisine"
            ? "RESTAURANT"
            : "GARDEN";
      const users = await this.auth.users
        .find({ businessType: type }, { projection: { _id: 1 } })
        .toArray();
      clauses.push({ ownerId: { $in: users.map((u) => u._id) } });
      if (query.section === "temples") filter.purpose = "NON_PROFIT";
    }
    if (scope === "saved") {
      const saved = await this.saves
        .find({ userId: actor.id }, { projection: { tradePostId: 1 } })
        .toArray();
      filter._id = { $in: saved.map((s) => s.tradePostId) };
      filter.status = "PUBLISHED";
      clauses.push(publicExpiry());
      const cats = await this.categories
        .find({ isActive: true, deletedAt: null }, { projection: { _id: 1 } })
        .toArray();
      clauses.push({ categoryId: { $in: cats.map((c) => c._id) } });
    }
    if (clauses.length) filter.$and = clauses;
    const direction = query.sortOrder === "asc" ? 1 : -1;
    let sort =
      query.sortBy === "rating"
        ? { averageRating: direction, reviewCount: direction, _id: 1 }
        : query.sortBy === "popular"
          ? { viewCount: direction, _id: 1 }
          : scope === "mine"
            ? { createdAt: direction, _id: 1 }
            : { publishedAt: direction, createdAt: direction, _id: 1 };
    const pipeline = [{ $match: filter }];
    if (["price_asc", "price_desc"].includes(query.sortBy)) {
      pipeline.push({
        $set: {
          _noPrice: {
            $cond: [{ $eq: [{ $ifNull: ["$price", null] }, null] }, 1, 0],
          },
        },
      });
      sort = {
        _noPrice: 1,
        price: query.sortBy === "price_asc" ? 1 : -1,
        _id: 1,
      };
    }
    const [rows, total] = await Promise.all([
      this.posts
        .aggregate([
          ...pipeline,
          { $sort: sort },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          { $unset: "_noPrice" },
        ])
        .toArray(),
      this.posts.countDocuments(filter),
    ]);
    const [owners, saved] = await Promise.all([
      this.auth.users
        .find(
          { _id: { $in: [...new Set(rows.map((row) => row.ownerId))] } },
          { projection: { displayName: 1, avatarUrl: 1, businessType: 1 } },
        )
        .toArray(),
      actor
        ? this.saves
            .find({
              userId: actor.id,
              tradePostId: { $in: rows.map((row) => row._id) },
            })
            .toArray()
        : [],
    ]);
    const ownersById = new Map(owners.map((owner) => [owner._id, owner])),
      savedIds = new Set(saved.map((row) => row.tradePostId));
    const data = rows.map((row) => {
      const owner = ownersById.get(row.ownerId);
      return {
        ...present(row),
        owner: owner
          ? {
              id: owner._id,
              displayName: owner.displayName,
              avatarUrl: owner.avatarUrl,
              businessType: owner.businessType,
            }
          : null,
        saved: savedIds.has(row._id),
        isOwner: actor?.id === row.ownerId,
      };
    });
    return { ...page([], total, query), data };
  }
  async images(imageIds, ownerId, reference, session) {
    const rows = [];
    for (const mediaId of imageIds || []) {
      const image = await this.media.findOneAndUpdate(
        { _id: mediaId, ownerId, deletedAt: null },
        { $addToSet: { references: reference } },
        { session, returnDocument: "after" },
      );
      if (!image)
        fail(
          400,
          "RESOURCE_NOT_FOUND",
          "Ảnh không thuộc tài khoản hoặc không còn tồn tại.",
        );
      rows.push({ id: image._id, url: image.originalUrl });
    }
    return rows;
  }
  async releaseImages(oldIds, newIds, reference, session) {
    const removed = oldIds.filter((i) => !newIds.includes(i));
    if (removed.length)
      await this.media.updateMany(
        { _id: { $in: removed } },
        { $pull: { references: reference } },
        { session },
      );
    return removed;
  }
  async validatePost(fields, owner, session, changed = fields) {
    seller(owner);
    const cat = await this.category(fields.category, session);
    // Serialize category use with deletion/reconfiguration.
    await this.categories.updateOne(
      { _id: cat._id },
      { $inc: { _useLock: 1 } },
      { session },
    );
    const post = { ...fields, categoryId: cat._id };
    const purposes = allowedPurposes(owner.businessType);
    post.purpose ??= purposes[0];
    if (!purposes.includes(post.purpose))
      fail(
        403,
        "TRADE_POST_PURPOSE_NOT_ALLOWED",
        "Loại hình doanh nghiệp không được đăng tin với mục đích này.",
      );
    if (post.purpose === "NON_PROFIT") {
      post.priceType = null;
      post.price = null;
      post.priceLabel = null;
      if (cat.requiresPromotionDetails)
        fail(
          400,
          "VALIDATION_ERROR",
          "Tin cộng đồng không thuộc danh mục ưu đãi thương mại.",
        );
    } else {
      post.eventStartAt = null;
      post.eventEndAt = null;
      if (!post.priceType || (post.priceType === "FIXED" && !(post.price > 0)))
        fail(
          400,
          "VALIDATION_ERROR",
          "Tin thương mại cần hình thức giá; giá cố định phải lớn hơn 0.",
        );
    }
    const promotions = [
      post.promotionPercent,
      post.promotionStartAt,
      post.promotionEndAt,
    ];
    if (
      cat.requiresPromotionDetails
        ? promotions.some((v) => v == null)
        : promotions.some((v) => v != null)
    )
      fail(
        400,
        "VALIDATION_ERROR",
        cat.requiresPromotionDetails
          ? "Vui lòng nhập đầy đủ mức ưu đãi và thời gian áp dụng."
          : "Danh mục này không sử dụng thông tin khuyến mãi.",
      );
    for (const field of [
      "promotionStartAt",
      "promotionEndAt",
      "eventStartAt",
      "eventEndAt",
      "expiresAt",
    ])
      if (post[field] != null) post[field] = new Date(post[field]);
    if (
      post.promotionStartAt &&
      post.promotionEndAt &&
      post.promotionStartAt >= post.promotionEndAt
    )
      fail(
        400,
        "VALIDATION_ERROR",
        "Ngày bắt đầu ưu đãi phải trước ngày kết thúc.",
      );
    if (
      post.eventStartAt &&
      post.eventEndAt &&
      post.eventStartAt > post.eventEndAt
    )
      fail(
        400,
        "VALIDATION_ERROR",
        "Ngày bắt đầu hoạt động không được sau ngày kết thúc.",
      );
    for (const field of [
      "expiresAt",
      ...(post.purpose === "NON_PROFIT" ? ["eventEndAt"] : []),
    ])
      if (changed[field] != null && post[field] <= new Date())
        fail(
          400,
          "VALIDATION_ERROR",
          "Ngày kết thúc hoặc hết hạn phải ở tương lai.",
        );
    return post;
  }
  async create(dto, actor) {
    seller(actor);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await this.tx(async (session) => {
          const postId = id();
          const now = new Date();
          const fields = await this.validatePost(
            { ...dto, imageIds: dto.imageIds || [] },
            actor,
            session,
          );
          const base =
            dto.title
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/[đĐ]/g, "d")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 160) || "giao-thuong";
          let slug = base,
            suffix = 1;
          while (
            slug === "me" ||
            (await this.posts.findOne({ slug }, { session }))
          )
            slug = base + "-" + ++suffix;
          const images = await this.images(
            fields.imageIds,
            actor.id,
            "post:" + postId,
            session,
          );
          const row = {
            _id: postId,
            ...fields,
            slug,
            images,
            thumbnailUrl: images[0]?.url || null,
            ownerId: actor.id,
            ownerMemberId: actor.memberId,
            status: "DRAFT",
            featured: false,
            viewCount: 0,
            saveCount: 0,
            averageRating: 0,
            reviewCount: 0,
            publishedAt: null,
            rejectedReason: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          await this.posts.insertOne(row, { session });
          return row;
        });
        return ok(present(result));
      } catch (error) {
        if (error.code !== 11000 || attempt === 4) throw error;
      }
    }
  }
  async update(postId, dto, actor) {
    const result = await this.tx(async (session) => {
      const old = await this.lockedPost(postId, session);
      owns(actor, old.ownerId);
      if (!staff(actor)) seller(actor);
      if (["PENDING", "ARCHIVED"].includes(old.status))
        fail(
          409,
          "TRADE_POST_NOT_EDITABLE",
          "Tin đang chờ duyệt hoặc đã lưu trữ không thể chỉnh sửa.",
        );
      const owner = await this.auth.owner(old.ownerId);
      const merged = await this.validatePost(
        { ...old, ...dto },
        owner,
        session,
        dto,
      );
      const significant = [
        "purpose",
        "title",
        "description",
        "category",
        "priceType",
        "price",
      ].some((k) => merged[k] !== old[k]);
      if (old.status === "PUBLISHED" && significant) merged.status = "PENDING";
      const removed = await this.releaseImages(
        old.imageIds || [],
        merged.imageIds || [],
        "post:" + postId,
        session,
      );
      merged.images = await this.images(
        merged.imageIds,
        old.ownerId,
        "post:" + postId,
        session,
      );
      merged.thumbnailUrl = merged.images[0]?.url || null;
      merged.updatedAt = new Date();
      const { _id, ...changes } = merged;
      await this.posts.updateOne(
        { _id: postId },
        { $set: changes },
        { session },
      );
      return {
        row: merged,
        submitted: old.status === "PUBLISHED" && significant,
        removed,
      };
    });
    if (result.submitted)
      await this.notify(
        "TRADE_POST_SUBMITTED",
        result.row,
        { submittedById: actor.id },
        { staff: true },
      );
    await this.mediaService?.cleanup(result.removed);
    return ok(present(result.row));
  }
  async transition(postId, action, dto, actor) {
    const result = await this.tx(async (session) => {
      const old = await this.lockedPost(postId, session);
      const now = new Date();
      let changes;
      const transitions = {
        submit: [["DRAFT", "REJECTED"], "PENDING"],
        approve: [["PENDING"], "PUBLISHED"],
        reject: [["PENDING"], "REJECTED"],
        hide: [["PUBLISHED"], "HIDDEN"],
        unhide: [["HIDDEN"], "PUBLISHED"],
        archive: [["PUBLISHED"], "ARCHIVED"],
      };
      if (action === "submit") {
        seller(actor);
        if (actor.id !== old.ownerId)
          fail(
            403,
            "RESOURCE_FORBIDDEN",
            "Chỉ doanh nghiệp chủ tin được gửi duyệt.",
          );
      } else if (!staff(actor))
        fail(403, "STAFF_REQUIRED", "Chỉ Ban quản trị Hội được kiểm duyệt.");
      if (action === "feature") changes = { featured: dto.featured };
      else {
        const rule = transitions[action];
        if (!rule || !rule[0].includes(old.status))
          fail(
            409,
            "INVALID_STATUS_TRANSITION",
            "Trạng thái tin đã thay đổi hoặc thao tác không phù hợp. Vui lòng tải lại.",
          );
        if (["submit", "approve", "unhide"].includes(action) && expired(old))
          fail(409, "TRADE_POST_EXPIRED", "Tin giao thương đã hết hạn.");
        if (["submit", "approve"].includes(action))
          await this.validatePost(
            old,
            await this.auth.owner(old.ownerId),
            session,
            {},
          );
        changes = { status: rule[1] };
        if (action === "hide") changes.featured = false;
        if (["submit", "approve"].includes(action))
          changes.rejectedReason = null;
        if (action === "approve")
          Object.assign(changes, {
            publishedAt: now,
            approvedAt: now,
            approvedById: actor.id,
          });
        if (action === "reject") changes.rejectedReason = dto.reason;
      }
      changes.updatedAt = now;
      await this.posts.updateOne(
        { _id: postId },
        { $set: changes },
        { session },
      );
      const row = { ...old, ...changes };
      if (staff(actor))
        await this.auditEntry(
          actor,
          "TRADE_POST_" + action.toUpperCase(),
          "TradePost",
          postId,
          present(old),
          present(row),
          session,
        );
      return { old, row };
    });
    const types = {
      submit: "SUBMITTED",
      approve: "APPROVED",
      reject: "REJECTED",
      hide: "HIDDEN",
      unhide: "UNHIDDEN",
      archive: "ARCHIVED",
      feature: "FEATURED",
    };
    if (action !== "feature" || (!result.old.featured && dto.featured))
      await this.notify(
        "TRADE_POST_" + types[action],
        result.row,
        { reason: dto.reason, submittedById: actor.id },
        action === "submit" ? { staff: true } : { userId: result.row.ownerId },
      );
    if (action === "approve" && !result.old.publishedAt)
      await this.notify(
        "TRADE_POST_NEW",
        result.row,
        { community: result.row.purpose === "NON_PROFIT" },
        { broadcast: true, excludeUserId: result.row.ownerId },
      );
    return ok(present(result.row));
  }
  async remove(postId, actor, admin = false) {
    const result = await this.tx(async (session) => {
      const row = await this.lockedPost(postId, session);
      owns(actor, row.ownerId);
      if (admin && !["PUBLISHED", "HIDDEN"].includes(row.status))
        fail(
          409,
          "INVALID_STATUS_TRANSITION",
          "Chỉ xóa qua kiểm duyệt khi tin đã công bố hoặc đang ẩn.",
        );
      await this.posts.updateOne(
        { _id: postId },
        { $set: { deletedAt: new Date(), featured: false } },
        { session },
      );
      await this.releaseImages(
        row.imageIds || [],
        [],
        "post:" + postId,
        session,
      );
      if (staff(actor))
        await this.auditEntry(
          actor,
          "TRADE_POST_DELETE",
          "TradePost",
          postId,
          present(row),
          null,
          session,
        );
      return row;
    });
    if (staff(actor))
      await this.notify(
        "TRADE_POST_DELETED",
        result,
        {},
        { userId: result.ownerId },
      );
    await this.mediaService?.cleanup(result.imageIds || []);
  }
}
