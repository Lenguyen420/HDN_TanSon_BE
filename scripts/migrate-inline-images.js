import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImageStorage, imageFolders } from "../src/services/imageStorage.js";
import { loadEnvironment } from "../src/config/environment.js";
import connectDB from "../src/config/database.js";

export async function migrateInlineImages(
  connection,
  {
    apply = false,
    backupDirectory = fileURLToPath(
      new URL("../.reference/inline-image-backups/", import.meta.url),
    ),
    verifyImage,
  } = {},
) {
  const items = [];
  for (const collection of imageFolders) {
    const rows = await connection
      .collection(collection.replaceAll("-", "_"))
      .find(
        {
          deletedAt: null,
          image: { $regex: "^data:image/" },
        },
        { projection: { _id: 1, image: 1 } },
      )
      .toArray();
    for (const row of rows)
      items.push({ collection, id: row._id, image: row.image });
  }
  if (!apply || !items.length)
    return { count: items.length, migrated: 0, dryRun: !apply };
  await mkdir(backupDirectory, { recursive: true });
  const backupFile = path.join(backupDirectory, randomUUID() + ".json");
  const backup = { createdAt: new Date().toISOString(), items };
  await writeFile(backupFile, JSON.stringify(backup), { flag: "wx" });
  const bucket = new mongoose.mongo.GridFSBucket(connection.db, {
    bucketName: "images",
  });
  const storage = new ImageStorage(undefined, bucket);
  let migrated = 0;
  for (const item of items) {
    const prepared = await storage.prepare(item.image, item.collection);
    try {
      if (verifyImage) await verifyImage(prepared.image, item.image);
      item.replacement = prepared.image;
      // Persist the original and replacement before changing a content record.
      await writeFile(backupFile, JSON.stringify(backup));
    } catch (error) {
      await storage.discard(prepared);
      throw error;
    }
    const result = await connection
      .collection(item.collection.replaceAll("-", "_"))
      .updateOne(
        { _id: item.id, image: item.image },
        { $set: { image: prepared.image } },
      );
    if (result.modifiedCount) migrated++;
    else await storage.discard(prepared); // A concurrent editor already changed this image.
  }
  return { count: items.length, migrated, backupFile, dryRun: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let connection;
  try {
    const config = loadEnvironment();
    connection = await connectDB(config.get("MONGODB_URI"));
    const originIndex = process.argv.indexOf("--verify-origin");
    const origin =
      originIndex < 0 ? null : new URL(process.argv[originIndex + 1]).origin;
    const result = await migrateInlineImages(connection, {
      apply: process.argv.includes("--apply"),
      verifyImage: origin
        ? async (image, original) => {
            const response = await fetch(new URL("/" + image, origin), {
              signal: AbortSignal.timeout(15000),
            });
            const bytes = Buffer.from(await response.arrayBuffer());
            if (
              !response.ok ||
              !bytes.equals(Buffer.from(original.split(",")[1], "base64"))
            )
              throw new Error(
                "Ảnh mới chưa truy cập được từ backend; bản ghi gốc được giữ nguyên.",
              );
          }
        : undefined,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Không chuyển được ảnh. Kiểm tra kết nối, backup và kho ảnh của backend.",
    );
    process.exitCode = 1;
  } finally {
    if (connection) await connection.close();
  }
}
