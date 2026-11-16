import { z } from "zod";
import {
  baseQuery,
  idSchema,
  text,
  dateSchema,
  avatarSchema,
} from "./member.dto.js";
const money = z.number().int().min(0).max(1_000_000_000_000);
const image = z.union([
  avatarSchema,
  z
    .string()
    .max(1_400_000)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
]);
const website = z.union([
  z.literal(""),
  z
    .url()
    .max(2048)
    .refine((v) => {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    }),
]);
const fields = {
  name: text(250).min(1),
  logo: image.default(""),
  industry: text(250).default(""),
  description: text(5000).default(""),
  address: text(500).default(""),
  website: website.default(""),
  memberId: idSchema.nullable().default(null),
  isPublished: z.boolean().default(false),
};
export const partnerSchema = z.strictObject({
  ...fields,
  requestId: z.uuid(),
  sendNotification: z.boolean().default(false),
});
const patchFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [
      key,
      (schema instanceof z.ZodDefault
        ? schema.removeDefault()
        : schema
      ).optional(),
    ]),
  );
export const partnerPatch = z.strictObject({
  ...patchFields(fields),
  sendNotification: z.boolean().optional(),
});
const contributionFields = {
  title: text(250).min(1),
  type: z.enum(["money", "in_kind"]),
  paymentMethod: z.enum(["cash", "bank_transfer"]).nullable().default(null),
  amount: money.nullable().default(null),
  itemName: text(250).default(""),
  quantity: z.number().positive().max(1e9).nullable().default(null),
  estimatedValue: money.nullable().default(null),
  contributionDate: dateSchema,
  description: text(5000).min(1),
  eventId: idSchema.nullable().default(null),
  images: z.array(image).max(3).default([]),
  isPublished: z.boolean().default(false),
  sendNotification: z.boolean().default(false),
};
export const contributionData = z
  .strictObject(contributionFields)
  .superRefine((v, ctx) => {
    if (v.type === "money" && (v.amount === null || !v.paymentMethod))
      ctx.addIssue({
        code: "custom",
        message: "Tài trợ bằng tiền cần số tiền và hình thức thanh toán.",
      });
    if (v.type === "in_kind" && (!v.itemName || !v.quantity))
      ctx.addIssue({
        code: "custom",
        message: "Tài trợ hiện vật cần tên và số lượng.",
      });
  });
export const contributionSchema = z.strictObject({
  ...contributionFields,
  requestId: z.uuid(),
});
export const contributionPatch = z.strictObject(
  patchFields(contributionFields),
);
export const partnerQuery = z.strictObject({
  ...baseQuery,
  sort: z.enum(["amount", "updated", "name"]).default("amount"),
  isPublished: z.enum(["true", "false"]).optional(),
});
export const publicPartnerQuery = partnerQuery.omit({ isPublished: true });
export const historyQuery = z.strictObject({
  ...baseQuery,
  contributionId: idSchema.optional(),
});
export const statisticsQuery = z
  .strictObject({ from: dateSchema.optional(), to: dateSchema.optional() })
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    "Khoảng ngày không hợp lệ.",
  );
