import { IntroductionVideoService } from "./services/introductionVideoService.js";
import { PublicNotificationService } from "./services/publicNotificationService.js";
import { LocalIntroductionVideoStorage } from "./services/localIntroductionVideoStorage.js";
import createEventAttendanceModel from "./models/EventAttendance.js";
import { EventAttendanceService } from "./services/eventAttendanceService.js";
import mongoose from "mongoose";
import { EventFileService } from "./services/eventFileService.js";
import express from "express";
import cors from "cors";
import { corsOptions } from "./config/cors.js";
import helmet from "helmet";
import { pathToFileURL } from "node:url";
import { loadEnvironment } from "./config/environment.js";
import connectDB, { logDatabaseStatus } from "./config/database.js";
import { createTokenService } from "./config/jwt.js";
import createAdminModel from "./models/AdminUser.js";
import createSessionModel from "./models/AuthSession.js";
import createMemberModel from "./models/Member.js";
import createZaloUserModel from "./models/ZaloUser.js";
import createZaloSdkProfileModel from "./models/ZaloSdkProfile.js";
import { ZaloSdkProfileService } from "./services/zaloSdkProfileService.js";
import createZaloOAuthModels from "./models/ZaloOAuth.js";
import { ZaloOAuthService } from "./services/zaloOAuthService.js";
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
import { MemberAccessService } from "./services/memberAccessService.js";
import { RegistrationService } from "./services/registrationService.js";
import { RegistrationNotificationService } from "./services/registrationNotificationService.js";
import appRouter from "./routers/appRouter.js";
import errorMiddleware from "./middlewares/errorMiddleware.js";
import { createApiRateLimiter } from "./middlewares/rateLimit.js";
import { TradeAuthService } from "./services/tradeAuthService.js";
import { TradeService } from "./services/tradeService.js";
import { TradeMediaService } from "./services/tradeMediaService.js";
import { TradeCommunityService } from "./services/tradeCommunityService.js";
import { TradeAnalyticsService } from "./services/tradeAnalyticsService.js";

export async function createApp({
  uploadDirectory = defaultUploadDirectory,
} = {}) {
  const config = loadEnvironment();
  const connection = await connectDB(config.get("MONGODB_URI"));
  try {
    const useMongoImages =
      process.env.IMAGE_STORAGE === "mongodb" || process.env.VERCEL === "1";
    const bucket = useMongoImages
      ? new mongoose.mongo.GridFSBucket(connection.db, { bucketName: "images" })
      : null;
    const imageReadBucket =
      bucket ??
      new mongoose.mongo.GridFSBucket(connection.db, { bucketName: "images" });
    const imageStorage = new ImageStorage(
      uploadDirectory,
      bucket,
      imageReadBucket,
    );
    await imageStorage.initialize();
    const models = {
      admins: createAdminModel(connection),
      sessions: createSessionModel(connection),
      members: createMemberModel(connection),
      zaloUsers: createZaloUserModel(connection),
      zaloSdkProfiles: createZaloSdkProfileModel(connection),
      zaloOAuth: createZaloOAuthModels(connection),
      registrations: createRegistrationModel(connection),
      content: createContentModels(connection),
      eventAttendance: createEventAttendanceModel(connection),
      settings: createSettingsModel(connection),
    };
    const introductionVideos = new IntroductionVideoService(connection.db);
    const localIntroductionVideos = new LocalIntroductionVideoStorage(
      uploadDirectory,
    );
    const services = {
      localIntroductionVideos,
      introductionVideos,
      eventFiles: new EventFileService(
        new mongoose.mongo.GridFSBucket(connection.db, {
          bucketName: "event_files",
        }),
      ),
      auth: new AuthService(
        models.admins,
        models.sessions,
        createTokenService(config.get("JWT_SECRET")),
        config,
      ),
      members: new MembersService(models.members, imageStorage),
      zaloSdkProfiles: new ZaloSdkProfileService(models.zaloSdkProfiles),
      registrationNotifications: new RegistrationNotificationService(
        models.registrations,
        models.members,
      ),
      memberAccess: new MemberAccessService(
        models.members,
        config,
        models.zaloUsers,
      ),
      settings: new SettingsService(
        models.settings,
        introductionVideos,
        localIntroductionVideos,
      ),
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
        imageStorage,
      ),
    };
    services.publicNotifications = new PublicNotificationService(
      services.content,
      models.members,
    );
    services.tradeAuth = new TradeAuthService(
      connection,
      models,
      createTokenService(config.get("JWT_SECRET")),
      services,
    );
    services.trade = new TradeService(
      connection,
      services.tradeAuth,
      config.get("TRADE_ANALYTICS_HASH_SECRET") || config.get("JWT_SECRET"),
    );
    services.trade.mediaService = new TradeMediaService(services.trade);
    services.trade.community = new TradeCommunityService(services.trade);
    services.trade.analytics = new TradeAnalyticsService(services.trade);
    services.eventAttendance = new EventAttendanceService(
      models.eventAttendance,
      services.content.events,
    );
    services.zaloOAuth = new ZaloOAuthService(
      models.zaloOAuth,
      config,
      services.memberAccess,
    );
    await Promise.all([
      services.trade.initialize(),
      introductionVideos.initialize(),
      models.eventAttendance.init(),
      models.zaloOAuth.flows.init(),
      models.zaloOAuth.sessions.init(),
      models.zaloUsers.init(),
      services.auth.initialize(),
      services.registrations.initialize(),
    ]);
    const app = express();
    // Vercel overwrites X-Forwarded-For. Other hosts opt in for their known proxy.
    const proxyHops =
      process.env.VERCEL === "1"
        ? 1
        : Number(config.get("TRUST_PROXY_HOPS") || 0);
    if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 10)
      throw new Error("TRUST_PROXY_HOPS phải là số nguyên từ 0 đến 10.");
    if (proxyHops) app.set("trust proxy", proxyHops);
    app.disable("x-powered-by");
    app.locals.db = connection;
    app.locals.models = models;
    app.locals.services = services;
    app.use(helmet());
    app.use(cors(corsOptions(config)));
    // Local videos must bypass the GridFS image middleware, which only accepts image paths.
    app.use(
      "/uploads/introduction-videos",
      express.static(localIntroductionVideos.directory, {
        dotfiles: "deny",
        index: false,
        maxAge: "1y",
        immutable: true,
        setHeaders: (res) =>
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
      }),
    );
    app.use("/uploads", imageStorage.middleware());
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
    // Content forms include a resized image up to 1.4 MB as a data URL.
    app.use("/api/v1/admin", (req, res, next) => {
      if (/^\/(members|registrations)(\/|$)/.test(req.path))
        return express.json({ limit: "3mb" })(req, res, next);
      if (
        /^\/(news|events|member-visits|notifications|banners)(\/|$)/.test(
          req.path,
        )
      )
        return express.json({ limit: "2mb" })(req, res, next);
      next();
    });
    // Registration includes one resized license photo, kept below Vercel's payload limit.
    app.use("/api/v1/public/registrations", express.json({ limit: "2mb" }));
    app.use(express.json({ limit: "256kb" }));
    app.use("/api/v1", createApiRateLimiter(), appRouter(services));
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
    const server = app.listen(port, host, (error) => {
      if (error) reject(error);
      else resolve(server);
    });
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
