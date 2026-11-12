import { z } from "zod";
import {
  idSchema,
  dateSchema,
  text,
  emailSchema,
  baseQuery,
} from "./member.dto.js";
const fields = {
  fullName: text(150).min(1),
  company: text(250).min(1),
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
  notificationToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const selfProfileSchema = z.strictObject({
  fullName: fields.fullName,
  company: fields.company,
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
