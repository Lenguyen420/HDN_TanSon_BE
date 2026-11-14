import { z } from "zod";
import { baseQuery, idSchema, text, avatarSchema } from "./member.dto.js";

export const categories = [
  ["du-lich", "Du lịch"],
  ["an-uong", "Ăn uống"],
  ["mua-sam", "Mua sắm"],
  ["doanh-nghiep", "Doanh nghiệp"],
  ["co-quan", "Cơ quan"],
  ["y-te", "Y tế"],
  ["giao-duc", "Giáo dục"],
  ["dich-vu", "Dịch vụ"],
  ["giai-tri", "Giải trí"],
  ["giao-thuong", "Giao thương"],
  ["khac", "Khác"],
].map(([code, name]) => ({ code, name }));
const plainText = (max) =>
  text(max).refine(
    (value) => !/[<>]/.test(value),
    "Nội dung chỉ hỗ trợ văn bản thuần.",
  );
const image = z
  .union([
    avatarSchema,
    z
      .string()
      .max(1_400_000)
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  ])
  .refine((value) => Boolean(value), "Ảnh không được trống.");
const url = z.union([
  z.literal(""),
  z
    .url()
    .max(2048)
    .refine((value) => {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    }, "URL phải sử dụng HTTP(S)."),
]);
export const categoryCode = text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const categoryCreate = z.strictObject({
  code: categoryCode,
  name: plainText(120).min(1),
});
export const categoryPatch = z.strictObject({ name: plainText(120).min(1) });
export const placeCreate = z.strictObject({
  name: plainText(200).min(1),
  category: categoryCode,
  description: plainText(1000).min(1),
  content: plainText(20000).optional(),
  address: plainText(500).min(1),
  location: z.strictObject({
    type: z.literal("Point"),
    coordinates: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
  }),
  coverImage: image,
  images: z.array(image).max(10).optional(),
  phone: text(30)
    .regex(/^$|^\+?[\d(). -]{7,30}$/)
    .optional(),
  website: url.optional(),
  zalo: url.optional(),
  openingHours: z
    .array(
      z.strictObject({
        day: z.number().int().min(0).max(6),
        open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(21)
    .optional(),
});
export const visibility = z.strictObject({
  isVisible: z.boolean(),
  reason: plainText(1000).optional(),
});
export const hidePlace = z.strictObject({ reason: plainText(1000).min(1) });
export const placePatch = placeCreate
  .partial()
  .extend({ isVisible: z.boolean().optional() })
  .refine(
    (value) => Object.keys(value).length > 0,
    "Cần ít nhất một trường cập nhật.",
  );
export const placesQuery = z.strictObject({
  ...baseQuery,
  category: categoryCode.optional(),
});
export { idSchema };
