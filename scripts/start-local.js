import { loadEnvironment } from "../src/config/environment.js";
import { bootstrap } from "../src/main.js";
import { defaultUploadDirectory } from "../src/services/imageStorage.js";
import { startupDiagnostic } from "../src/utils/startupDiagnostic.js";

try {
  loadEnvironment();
  // Local runs use the persistent project uploads folder, even if a shell
  // or copied .env still contains Vercel deployment flags.
  delete process.env.VERCEL;
  process.env.NODE_ENV = "development";
  process.env.TRUST_PROXY_HOPS = "0";
  const { server } = await bootstrap();
  const port = server.address().port;
  console.log(`[Local] API: http://localhost:${port}/api/v1`);
  console.log(`[Local] Health: http://localhost:${port}/api/v1/health`);
  console.log(`[Local] Video uploads: ${defaultUploadDirectory}`);
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? "[Local] Cổng backend đang được sử dụng. Chỉ chạy một backend."
      : `[Local] ${startupDiagnostic(error)}`,
  );
  process.exitCode = 1;
}
