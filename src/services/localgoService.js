import { randomUUID } from "node:crypto";
import { HttpError, NotFoundError } from "../utils/httpError.js";

const isAdmin = (actor) => ["SUPER_ADMIN", "STAFF"].includes(actor?.role);
const present = ({ _id, __v, auditLog, ...row }) => ({ ...row, id: _id });
const publicFilter = { deletedAt: null, status: "published", isVisible: true };
export class LocalGoService {
  constructor(places) {
    this.places = places;
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
  async create(dto, actor) {
    const row = await this.places.create({
      ...dto,
      _id: randomUUID(),
      memberId: actor.memberId || null,
      createdBy: actor.id,
      status: "published",
      isVisible: true,
      publishedAt: new Date(),
      auditLog: [this.audit("create", actor)],
    });
    return { data: present(row.toObject()) };
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
    const updated = await this.places
      .findOneAndUpdate(
        filter,
        {
          $set: dto,
          $push: { auditLog: this.audit(action, actor, reason) },
        },
        { new: true, runValidators: true },
      )
      .lean();
    if (!updated) throw new NotFoundError("Không tìm thấy địa điểm.");
    return { data: present(updated) };
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
