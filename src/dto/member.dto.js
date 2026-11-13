import { z } from "zod";
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const dateSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "Ngày phải đúng định dạng YYYY-MM-DD và tồn tại.",
  );
export const companyFoundedAtSchema = z
  .union([dateSchema, z.literal("")])
  .refine(
    (value) =>
      !value ||
      value <=
        new Date().toLocaleDateString("en-CA", {
          timeZone: "Asia/Ho_Chi_Minh",
        }),
    "Ngày thành lập không được ở tương lai.",
  )
  .optional();
export const text = (max) => z.string().trim().max(max);
export const emailSchema = text(254).regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/);
export const avatarSchema = z.union([
  z.literal(""),
  z
    .string()
    .max(2048)
    .refine((value) => {
      if (/^\/?uploads\/[a-z0-9/-]+\.(jpg|png|webp)$/i.test(value)) return true;
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    }, "URL ảnh đại diện không hợp lệ."),
]);
export const memberSchema = z.strictObject({
  id: idSchema.optional(),
  name: text(150).min(1),
  avatar: z
    .union([
      avatarSchema,
      z
        .string()
        .max(1_400_000)
        .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
    ])
    .optional(),
  businessLicenseImage: z
    .string()
    .max(1_400_000)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  zaloUserId: z
    .string()
    .trim()
    .regex(/^$|^\d{1,100}$/)
    .optional(),
  company: text(250).min(1),
  companyFoundedAt: companyFoundedAtSchema,
  jobTitle: text(100).optional(),
  phone: text(30)
    .regex(/^[+\d(). -]{0,30}$/)
    .optional(),
  email: emailSchema.optional(),
  birthDate: z.union([dateSchema, z.literal("")]).optional(),
  joinedAt: dateSchema,
  companyAddress: text(500).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  isBoard: z.boolean().optional(),
  position: text(100).min(1).optional(),
});
export const baseQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(150).optional(),
};
export const membersQuery = z.strictObject({
  ...baseQuery,
  status: z.enum(["active", "inactive"]).optional(),
  isBoard: z.enum(["true", "false"]).optional(),
});
export const importMembersSchema = z.strictObject({
  members: z.array(memberSchema).max(100),
});
