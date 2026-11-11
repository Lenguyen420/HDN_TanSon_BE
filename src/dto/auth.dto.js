import { z } from "zod";
export const loginSchema = z.strictObject({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
});
export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(1).max(512),
});
