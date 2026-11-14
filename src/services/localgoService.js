import { randomUUID } from "node:crypto";
import { categories as defaultCategories } from "../dto/localgo.dto.js";
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
} from "../utils/httpError.js";

const isAdmin = (actor) => ["SUPER_ADMIN", "STAFF"].includes(actor?.role);
const present = ({ _id, __v, auditLog, ...row }) => ({ ...row, id: _id });
const publicFilter = { deletedAt: null, status: "published", isVisible: true };
export class LocalGoService {
  constructor(places, categories, imageStorage) {
    this.places = places;
    this.categories = categories;
    this.imageStorage = imageStorage;
  }
  async initialize() {
    await this.categories.init();
    // Insert missing defaults once; never overwrite renamed or deleted categories.
    await this.categories.bulkWrite(
      defaultCategories.map(({ code, name }, order) => ({
        updateOne: {
          filter: { _id: code },
          update: {
            $setOnInsert: { name, order, revision: 0, deletedAt: null },
          },
          upsert: true,
          timestamps: false,
        },
      })),
    );
  }
  async listCategories() {
    const rows = await this.categories
      .find({ deletedAt: null })
      .sort({ order: 1, createdAt: 1, _id: 1 })
      .lean();
    return rows.map((row) => ({ code: row._id, name: row.name }));
  }
  async createCategory({ code, name }) {
    await this.categories.create({ _id: code, name });
    return { code, name };
  }
  async updateCategory(code, { name }) {
    const row = await this.categories
      .findOneAndUpdate(
        { _id: code, deletedAt: null },
        { $set: { name } },
        { new: true, runValidators: true },
      )
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy danh mục.");
    return { code: row._id, name: row.name };
  }
  async removeCategory(code) {
    await this.places.db.transaction(async (session) => {
      const row = await this.categories.findOneAndUpdate(
        { _id: code, deletedAt: null },
        { $inc: { revision: 1 } },
        { session },
      );
      if (!row) throw new NotFoundError("Không tìm thấy danh mục.");
      const used = await this.places
        .exists({ category: code, deletedAt: null })
        .session(session);
      if (used)
        throw new ConflictError(
          "Danh mục đang có địa điểm sử dụng. Hãy chuyển hoặc xóa các địa điểm trước.",
        );
      await this.categories.updateOne(
        { _id: code },
        { $set: { deletedAt: new Date() } },
        { session },
      );
    });
  }
  async withCategory(code, operation) {
    return this.places.db.transaction(async (session) => {
      // Touch the same category document as deletion so concurrent assignments
      // cannot leave a live place referring to a deleted category.
      const category = await this.categories.findOneAndUpdate(
        { _id: code, deletedAt: null },
        { $inc: { revision: 1 } },
        { session },
      );
      if (!category)
        throw new BadRequestError("Danh mục không tồn tại hoặc đã bị xóa.");
      return operation(session);
    });
  }
  scope(actor, mode) {
    if (mode === "public") return { ...publicFilter };
    if (mode === "admin") {
      if (!isAdmin(actor))
        throw new HttpError(403, "Bạn không có quyền truy cập.");
      return { deletedAt: null };
    }
    return {
      deletedAt: null,
      memberId: actor.memberId || null,
      ...(!actor.memberId ? { createdBy: actor.id } : {}),
    };
  }
  async list(query, actor, mode = "public") {
    const filter = this.scope(actor, mode);
    if (query.category) filter.category = query.category;
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = ["name", "address", "description"].map((key) => ({
        [key]: { $regex: escaped, $options: "i" },
      }));
    }
    const [rows, total] = await Promise.all([
      this.places
        .find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.places.countDocuments(filter),
    ]);
    return {
      data: rows.map(present),
      pagination: { page: query.page, limit: query.limit, total },
    };
  }
  async get(id, actor, manage = false) {
    const row = await this.places
      .findOne({ _id: id, ...(manage ? { deletedAt: null } : publicFilter) })
      .lean();
    if (!row) throw new NotFoundError("Không tìm thấy địa điểm.");
    if (manage) this.authorize(row, actor);
    return { data: present(row) };
  }
  authorize(row, actor) {
    if (
      !isAdmin(actor) &&
      (!actor?.memberId || row.memberId !== actor.memberId)
    )
      throw new HttpError(403, "Bạn chỉ được quản lý địa điểm của mình.");
  }
  audit(action, actor, reason = "") {
    return { action, actorId: actor.id, reason, at: new Date() };
  }
  async withImages(dto, current, operation) {
    const prepared = [];
    const fields = { ...dto };
    const prepare = async (value) => {
      const saved = await this.imageStorage.prepare(value, "localgo");
      prepared.push(saved);
      return saved.image;
    };
    try {
      if (
        fields.coverImage !== undefined &&
        fields.coverImage !== current?.coverImage
      )
        fields.coverImage = await prepare(fields.coverImage);
      if (fields.images !== undefined) {
        const images = [];
        for (const value of fields.images)
          images.push(
            current?.images?.includes(value) ? value : await prepare(value),
          );
        fields.images = images;
      }
      return await operation(fields);
    } catch (error) {
      await Promise.all(
        prepared.map((item) => this.imageStorage.discard(item)),
      );
      throw error;
    }
  }
  async create(dto, actor) {
    return this.withImages(dto, null, (fields) =>
      this.withCategory(fields.category, async (session) => {
        const [row] = await this.places.create(
          [
            {
              ...fields,
              _id: randomUUID(),
              memberId: actor.memberId || null,
              createdBy: actor.id,
              status: "published",
              isVisible: true,
              publishedAt: new Date(),
              auditLog: [this.audit("create", actor)],
            },
          ],
          { session },
        );
        return { data: present(row.toObject()) };
      }),
    );
  }
  async update(id, dto, actor, action = "update", reason = "") {
    const row = await this.places.findOne({ _id: id, deletedAt: null }).lean();
    if (!row) throw new NotFoundError("Không tìm thấy địa điểm.");
    this.authorize(row, actor);
    const filter = {
      _id: id,
      deletedAt: null,
      ...(!isAdmin(actor) ? { memberId: actor.memberId } : {}),
    };
    return this.withImages(dto, row, async (fields) => {
      const perform = async (session) => {
        const updated = await this.places
          .findOneAndUpdate(
            filter,
            {
              $set: fields,
              $push: { auditLog: this.audit(action, actor, reason) },
            },
            { new: true, runValidators: true, ...(session ? { session } : {}) },
          )
          .lean();
        if (!updated) throw new NotFoundError("Không tìm thấy địa điểm.");
        return { data: present(updated) };
      };
      return fields.category
        ? this.withCategory(fields.category, perform)
        : perform();
    });
  }
  async remove(id, actor) {
    await this.update(
      id,
      { deletedAt: new Date(), isVisible: false },
      actor,
      "delete",
    );
  }
}
