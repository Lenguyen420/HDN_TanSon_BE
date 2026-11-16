import { z } from "zod";
import { baseQuery, dateSchema, idSchema, text } from "./member.dto.js";
export const campaignSchema = z
  .strictObject({
    title: text(200).min(1),
    year: z.number().int().min(2000).max(2200),
    description: text(5000).default(""),
    amount: z.number().int().positive().max(1_000_000_000),
    dueDate: dateSchema,
    target: z.enum(["all", "selected"]),
    targetMemberIds: z.array(idSchema).max(10000).default([]),
    paymentInstructions: text(5000).default(""),
    status: z.enum(["draft", "published"]).default("draft"),
  })
  .refine(
    (v) => v.target !== "selected" || v.targetMemberIds.length > 0,
    "Vui lòng chọn hội viên.",
  );
export const campaignPatch = z.strictObject({
  title: text(200).min(1).optional(),
  year: z.number().int().min(2000).max(2200).optional(),
  description: text(5000).optional(),
  amount: z.number().int().positive().max(1_000_000_000).optional(),
  dueDate: dateSchema.optional(),
  target: z.enum(["all", "selected"]).optional(),
  targetMemberIds: z.array(idSchema).max(10000).optional(),
  paymentInstructions: text(5000).optional(),
  status: z.enum(["draft", "closed"]).optional(),
});
const proofFields = {
  transactionRef: text(150).min(1).optional(),
  proofUrl: z
    .union([
      z.literal(""),
      z
        .url()
        .max(2048)
        .refine((v) => {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password;
        }, "Minh chứng cần đường dẫn HTTPS."),
    ])
    .default(""),
  note: text(2000).default(""),
};
export const proofSchema = z
  .strictObject({
    ...proofFields,
    proofImage: z
      .string()
      .max(1400000)
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
  })
  .refine(
    (v) => Boolean(v.proofImage || v.transactionRef),
    "Vui lòng chọn ảnh minh chứng.",
  );
export const manualPaymentSchema = z.strictObject({
  ...proofFields,
  proofImage: z
    .string()
    .max(1400000)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  method: z.enum(["bank_transfer", "cash"]),
});
export const decisionSchema = z.strictObject({ note: text(2000).default("") });
export const campaignQuery = z.strictObject({
  ...baseQuery,
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  status: z.enum(["draft", "published", "closed"]).optional(),
});
export const duesQuery = z.strictObject({
  ...baseQuery,
  status: z
    .enum(["unpaid", "overdue", "pending_confirmation", "paid", "cancelled"])
    .optional(),
});
