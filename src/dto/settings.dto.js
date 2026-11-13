import { managedVideoPattern } from "../services/introductionVideoService.js";
import { localVideoPattern } from "../services/localIntroductionVideoStorage.js";
import { z } from "zod";
import { emailSchema, text } from "./member.dto.js";

export const defaultSettings = Object.freeze({
  name: "Hội Doanh nghiệp Phường Tân Sơn",
  slogan: "Trách nhiệm - Sẵn sàng - Vươn mình",
  introduction: "",
  introductionVideoUrl: "",
  mission: "",
  department: "",
  address: "",
  hours: "",
  phone: "",
  email: "",
  zaloUrl: "",
  assistantGreeting: "",
  assistantQuestions: "",
});

export const settingsSchema = z.strictObject({
  id: z.literal("association").optional(),
  name: text(250).min(1),
  slogan: text(500).min(1),
  introduction: text(20_000).default(""),
  introductionVideoUrl: text(2048)
    .refine((value) => {
      if (
        !value ||
        managedVideoPattern.test(value) ||
        localVideoPattern.test(value)
      )
        return true;
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "Video giới thiệu cần đường dẫn uploads hoặc URL HTTPS hợp lệ.")
    .optional(),
  mission: text(20_000).default(""),
  department: text(250).default(""),
  address: text(1000).default(""),
  hours: text(500).default(""),
  phone: text(30)
    .regex(/^[+\d(). -]*$/)
    .default(""),
  email: emailSchema.default(""),
  zaloUrl: text(2048)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "Liên kết Zalo phải là URL HTTPS hợp lệ.")
    .default(""),
  assistantGreeting: text(5000).default(""),
  assistantQuestions: text(30_000)
    .refine((value) => {
      const lines = value.split(/\r?\n/).filter((line) => line.trim());
      return (
        lines.length <= 100 &&
        lines.every((line) => {
          const separator = line.indexOf("|");
          return (
            separator > 0 &&
            line.slice(0, separator).trim() &&
            line.slice(separator + 1).trim()
          );
        })
      );
    }, "Tối đa 100 câu hỏi, mỗi dòng có dạng: câu hỏi | câu trả lời.")
    .default(""),
});

export const emptySettingsQuery = z.strictObject({});
