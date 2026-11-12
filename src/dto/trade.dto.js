import { z } from "zod";
const text = (n) => z.string().trim().min(1).max(n);
export const uuid = z.string().uuid();
export const statuses = [
  "DRAFT",
  "PENDING",
  "PUBLISHED",
  "HIDDEN",
  "REJECTED",
  "EXPIRED",
  "ARCHIVED",
];
const date = z.string().datetime({ offset: true }).nullable();
const googleMaps = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (["maps.google.com", "maps.google.com.vn", "maps.app.goo.gl"].includes(
        u.hostname,
      ) ||
        (u.hostname === "goo.gl" && u.pathname.startsWith("/maps/")) ||
        ([
          "google.com",
          "www.google.com",
          "google.com.vn",
          "www.google.com.vn",
        ].includes(u.hostname) &&
          (u.pathname === "/maps" || u.pathname.startsWith("/maps/"))))
    );
  }, "Liên kết Google Maps không hợp lệ.")
  .nullable();
export const postFields = {
  category: text(50).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/),
  title: text(200),
  summary: text(500),
  description: text(5000),
  purpose: z.enum(["COMMERCIAL", "NON_PROFIT"]),
  priceType: z.enum(["FIXED", "NEGOTIABLE", "CONTACT"]).nullable(),
  price: z
    .number()
    .finite()
    .min(0)
    .max(999999999999.99)
    .refine(
      (v) => Number(v.toFixed(2)) === v,
      "Giá chỉ có tối đa 2 số thập phân.",
    )
    .nullable(),
  priceLabel: text(100).nullable(),
  address: text(300),
  googleMapsUrl: googleMaps,
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  contactName: text(120),
  contactPhone: text(20).regex(
    /^(\+?84|0)[0-9]{9}$/,
    "Số điện thoại Việt Nam không hợp lệ.",
  ),
  contactZalo: text(120).nullable(),
  promotionPercent: z.number().int().min(1).max(100).nullable(),
  promotionStartAt: date,
  promotionEndAt: date,
  eventStartAt: date,
  eventEndAt: date,
  expiresAt: date,
  imageIds: z
    .array(uuid)
    .max(10)
    .refine((v) => new Set(v).size === v.length, "Ảnh không được trùng."),
};
const optionalFields = Object.fromEntries(
  Object.entries(postFields).map(([key, schema]) => [key, schema.optional()]),
);
export const postCreate = z.strictObject({
  ...optionalFields,
  category: postFields.category,
  title: postFields.title,
  summary: postFields.summary,
  description: postFields.description,
  address: postFields.address,
  contactName: postFields.contactName,
  contactPhone: postFields.contactPhone,
});
export const postPatch = z
  .strictObject(optionalFields)
  .refine((v) => Object.keys(v).length > 0, "Chưa có nội dung thay đổi.");
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const query = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: text(200).optional(),
  category: text(50).optional(),
  ownerId: uuid.optional(),
  featured: bool.optional(),
  purpose: z.enum(["COMMERCIAL", "NON_PROFIT"]).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  section: z
    .enum(["temples", "specialties", "agriculture", "cuisine"])
    .optional(),
  sortBy: z
    .enum(["newest", "price_asc", "price_desc", "rating", "popular"])
    .default("newest"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum([...statuses, "ACTIVE", "BLOCKED"]).optional(),
  tradePostId: uuid.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export const categoryFields = {
  code: text(50).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/),
  name: text(120),
  description: z.string().trim().max(300).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
  requiresPromotionDetails: z.boolean().optional(),
};
export const categoryCreate = z.strictObject(categoryFields);
export const categoryPatch = z.strictObject({
  ...Object.fromEntries(
    Object.entries(categoryFields).map(([k, v]) => [k, v.optional()]),
  ),
  version: z.number().int().min(1),
});
export const reorder = z.strictObject({
  items: z
    .array(z.strictObject({ id: uuid, version: z.number().int().min(1) }))
    .min(1)
    .max(200)
    .refine(
      (items) => new Set(items.map((i) => i.id)).size === items.length,
      "Danh mục không được trùng.",
    ),
});
export const reviewFields = {
  rating: z.number().int().min(1).max(5),
  content: text(500),
  imageIds: z
    .array(uuid)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
};
export const reviewCreate = z.strictObject(reviewFields);
export const reviewPatch = z.strictObject({
  rating: reviewFields.rating.optional(),
  content: reviewFields.content.optional(),
  imageIds: reviewFields.imageIds,
});
export const reply = z.strictObject({ content: text(500) });
export const message = z.strictObject({ content: text(1000) });
export const reason = z.strictObject({ reason: text(1000) });
