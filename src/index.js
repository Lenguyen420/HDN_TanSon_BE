import express from "express";
import { createApp } from "./main.js";
import errorMiddleware from "./middlewares/errorMiddleware.js";

// Vercel detects this entry without opening a local port or connecting at build time.
const app = express();
app.disable("x-powered-by");
let application;
app.use(async (req, res, next) => {
  // Concurrent cold-start requests share initialization and the MongoDB connection.
  application ??= createApp().catch((error) => {
    application = undefined;
    throw error;
  });
  try {
    const backend = await application;
    backend(req, res, next);
  } catch (error) {
    next(error);
  }
});
app.use(errorMiddleware);

export default app;
