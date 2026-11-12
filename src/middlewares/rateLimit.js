import { rateLimit } from "express-rate-limit";
export const createRateLimiter = (limit) =>
  rateLimit({
    windowMs: 60000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Express uses X-Forwarded-For with explicitly configured trusted proxy hops.
    // Do not trust arbitrary standardized Forwarded headers supplied by clients.
    validate: { forwardedHeader: false },
    message: {
      statusCode: 429,
      message: "Quá nhiều yêu cầu. Vui lòng thử lại sau.",
    },
  });
