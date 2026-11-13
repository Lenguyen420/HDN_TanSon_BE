import { z } from "zod";
import { businessLicensePattern } from "../services/businessLicenseStorage.js";
import {
  idSchema,
  dateSchema,
  companyFoundedAtSchema,
  text,
  emailSchema,
  baseQuery,
  avatarSchema,
  memberSchema,
} from "./member.dto.js";
const fields = {
  avatar: avatarSchema.optional(),
  fullName: text(150).min(1),
  company: text(250).min(1),
  companyFoundedAt: companyFoundedAtSchema,
  phone: text(30)
    .min(1)
    .regex(/^[+\d(). -]{1,30}$/),
  email: emailSchema.optional(),
  birthDate: z.union([dateSchema, z.literal("")]).optional(),
  jobTitle: text(100).optional(),
  companyAddress: text(500).optional(),
  taxCode: text(30).optional(),
  note: text(3000).optional(),
};
export const publicRegistrationSchema = z.strictObject({
  ...fields,
  businessLicenseImage: z
    .string()
    .max(1_400_000)
    .regex(
      businessLicensePattern,
      "Ảnh giấy phép kinh doanh là bắt buộc (JPG, PNG hoặc WebP).",
    ),
  notificationToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const selfProfileSchema = z.strictObject({
  fullName: fields.fullName,
  company: fields.company,
  companyFoundedAt: fields.companyFoundedAt,
  phone: fields.phone,
  email: fields.email,
  birthDate: fields.birthDate,
  jobTitle: fields.jobTitle,
  companyAddress: fields.companyAddress,
  taxCode: fields.taxCode,
  tokens: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(20),
});
export const registrationSchema = z.strictObject({
  ...fields,
  avatar: memberSchema.shape.avatar,
  businessLicenseImage:
    publicRegistrationSchema.shape.businessLicenseImage.optional(),
  id: idSchema.optional(),
  date: dateSchema,
});
export const importRegistrationsSchema = z.strictObject({
  registrations: z
    .array(
      registrationSchema.extend({
        status: z.enum(["pending", "approved", "rejected"]).optional(),
        memberId: idSchema.optional(),
      }),
    )
    .max(100),
});
export const registrationsQuery = z.strictObject({
  ...baseQuery,
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});
export const rejectSchema = z.strictObject({ reason: text(1000).optional() });
export const approveSchema = z.strictObject({});
