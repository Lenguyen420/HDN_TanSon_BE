import mongoose from "mongoose";
import { setServers } from "node:dns";
export default async function connectDB(uri) {
  const servers = process.env.MONGODB_DNS_SERVERS?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers?.length) setServers(servers);
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 10000,
  });
  connection.on("disconnected", () =>
    console.warn("[Database] MongoDB disconnected"),
  );
  connection.on("reconnected", () =>
    console.log("[Database] MongoDB reconnected successfully"),
  );
  connection.on("error", () =>
    console.error(
      "[Database] MongoDB connection error. Kiểm tra Atlas và .env.",
    ),
  );
  try {
    await connection.asPromise();
    return connection;
  } catch {
    await connection.close().catch(() => {});
    throw new Error(
      "Không kết nối được MongoDB. Kiểm tra URI, DNS và IP được phép trên Atlas.",
    );
  }
}
export function logDatabaseStatus(connection) {
  if (connection.readyState === 1)
    console.log("[Database] MongoDB connected successfully");
  else console.warn("[Database] MongoDB chưa sẵn sàng.");
}
