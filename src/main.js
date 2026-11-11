import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pathToFileURL } from "node:url";
import { loadEnvironment } from "./config/environment.js";
import connectDB, { logDatabaseStatus } from "./config/database.js";
import { createTokenService } from "./config/jwt.js";
import createAdminModel from "./models/AdminUser.js";
import createSessionModel from "./models/AuthSession.js";
import createMemberModel from "./models/Member.js";
import createRegistrationModel from "./models/Registration.js";
import createContentModels from "./models/Content.js";
import createSettingsModel from "./models/AssociationSettings.js";
import { SettingsService } from "./services/settingsService.js";
import { ContentService } from "./services/contentService.js";
import {
  ImageStorage,
  defaultUploadDirectory,
} from "./services/imageStorage.js";
import { contentDefinitions } from "./dto/content.dto.js";
import { AuthService } from "./services/authService.js";
import { MembersService } from "./services/memberService.js";
import { RegistrationService } from "./services/registrationService.js";
import appRouter from "./routers/appRouter.js";
import errorMiddleware from "./middlewares/errorMiddleware.js";
import { createRateLimiter } from "./middlewares/rateLimit.js";

export async function createApp({
  uploadDirectory = defaultUploadDirectory,
} = {}) {
  const config = loadEnvironment();
  const connection = await connectDB(config.get("MONGODB_URI"));
  try {
    const imageStorage = new ImageStorage(uploadDirectory);
    await imageStorage.initialize();
    const models = {
      admins: createAdminModel(connection),
      sessions: createSessionModel(connection),
      members: createMemberModel(connection),
      registrations: createRegistrationModel(connection),
      content: createContentModels(connection),
      settings: createSettingsModel(connection),
    };
    const services = {
      auth: new AuthService(
        models.admins,
        models.sessions,
        createTokenService(config.get("JWT_SECRET")),
        config,
      ),
      members: new MembersService(models.members),
      settings: new SettingsService(models.settings),
      content: Object.fromEntries(
        Object.entries(contentDefinitions).map(([key, definition]) => [
          key,
          new ContentService(
            models.content[key],
            definition,
            imageStorage,
            key,
          ),
        ]),
      ),
      registrations: new RegistrationService(
        models.registrations,
        models.members,
        connection,
      ),
    };
    await services.auth.initialize();
    await services.registrations.initialize();
    const app = express();
    app.disable("x-powered-by");
    app.locals.db = connection;
    app.locals.models = models;
    app.locals.services = services;
    app.use(helmet());
    app.use(
      "/uploads",
      express.static(uploadDirectory, {
        dotfiles: "deny",
        index: false,
        maxAge: "1y",
        immutable: true,
        setHeaders: (res) =>
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
      }),
    );
    app.use(
      cors({
        origin: (config.get("CORS_ORIGINS") || "http://localhost:3003")
          .split(",")
          .map((x) => x.trim()),
        credentials: true,
      }),
    );
    // Content forms include a resized image up to 1.4 MB as a data URL.
    app.use("/api/v1/admin", (req, res, next) => {
      if (
        /^\/(news|events|member-visits|notifications|banners)(\/|$)/.test(
          req.path,
        )
      )
        return express.json({ limit: "2mb" })(req, res, next);
      next();
    });
    app.use(express.json({ limit: "256kb" }));
    app.use("/api/v1", createRateLimiter(120), appRouter(services));
    app.use((req, res) =>
      res.status(404).json({ statusCode: 404, message: "Không tìm thấy API." }),
    );
    app.use(errorMiddleware);
    return app;
  } catch (error) {
    await connection.close();
    throw error;
  }
}
export function listen(
  app,
  port = Number(process.env.PORT || 4000),
  host = process.env.HOST || "127.0.0.1",
) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}
export async function closeApp(app, server) {
  if (server)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await app.locals.db.close();
}
export async function bootstrap() {
  const app = await createApp();
  let server;
  try {
    server = await listen(app);
  } catch (error) {
    await app.locals.db.close();
    throw error;
  }
  console.log("[Server] Express started on port " + server.address().port);
  logDatabaseStatus(app.locals.db);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void closeApp(app, server)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { app, server };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  bootstrap().catch((error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "[Server] Cổng đang được sử dụng. Chỉ chạy một backend."
        : "[Server] Backend chưa khởi động được. Kiểm tra .env, MongoDB và cấu hình máy.",
    );
    process.exitCode = 1;
  });
