// Zalo hosts deployed Mini Apps on this origin (including Testing/Live).
export function corsOptions(config) {
  const origins = new Set([
    "https://h5.zdn.vn",
    ...(config.get("CORS_ORIGINS") || "http://localhost:3003")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);
  return {
    origin(origin, callback) {
      callback(null, Boolean(origin && origins.has(origin)));
    },
    credentials: true,
  };
}
