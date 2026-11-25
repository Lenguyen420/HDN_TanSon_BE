import { z } from "zod";
import { dateSchema, idSchema, text } from "./member.dto.js";
import {
  financeTypes,
  financeCategories,
  financeMethods,
} from "../models/Finance.js";

export const financeDate = dateSchema.refine(
  (value) => value >= "1900-01-01",
  "Ngày sổ quỹ phải từ 1900 trở đi.",
);
const amount = z.number().int().positive().max(1_000_000_000_000);
const businessFields = {
  businessDate: financeDate,
  type: z.enum(financeTypes),
  amount,
  content: text(1000).min(1),
  category: z.enum(financeCategories),
  paymentMethod: z.enum(financeMethods),
  counterparty: text(250),
  referenceNo: text(250),
  note: text(2000),
};
const fileSchema = z.strictObject({
  name: text(200).min(1),
  base64: z
    .string()
    .min(4)
    .max(1_398_104)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const uploads = z.array(fileSchema).max(3);
const version = z.number().int().positive();
const reason = text(1000).min(1);
export const openingBody = z.strictObject({
  openingDate: financeDate,
  openingBalance: z.number().int().min(0).max(999_999_999_999_999),
});
export const newEntryBody = z.strictObject({
  ...businessFields,
  counterparty: businessFields.counterparty.default(""),
  referenceNo: businessFields.referenceNo.default(""),
  note: businessFields.note.default(""),
  attachments: uploads.default([]),
});
export const patchEntryBody = z
  .strictObject({
    ...Object.fromEntries(
      Object.entries(businessFields).map(([field, schema]) => [
        field,
        schema.optional(),
      ]),
    ),
    version,
    attachments: uploads.optional(),
    retainAttachmentIds: z.array(idSchema).max(3).optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 1,
    "Cần ít nhất một trường cần sửa.",
  );
export const voidBody = z.strictObject({ version, reason });
export const reverseBody = z.strictObject({
  businessDate: financeDate,
  reason,
});
export const sponsorshipBody = z.strictObject({ businessDate: financeDate });
export const previewBody = z.strictObject({
  businessDate: financeDate,
  type: z.enum(financeTypes),
  amount,
});
export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const rangeFields = {
  from: financeDate.optional(),
  to: financeDate.optional(),
};
export const financePage = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const rangeQuery = z.strictObject(rangeFields);
export const dailyQuery = z.strictObject({
  ...rangeFields,
  ...financePage,
  type: z.enum(financeTypes).optional(),
  q: text(200).optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  includeEmpty: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export const dayDetailQuery = z.strictObject({
  ...financePage,
  type: z.enum(financeTypes).optional(),
  q: text(200).optional(),
});
