import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadEnvironment } from "../src/config/environment.js";
import connectDB from "../src/config/database.js";
import {
  defaultUploadDirectory,
  imageFolders,
  uploadedImagePattern,
} from "../src/services/imageStorage.js";

const apply = process.argv.includes("--apply");
const files = [];
for (const folder of imageFolders) {
  const directory = path.join(defaultUploadDirectory, folder);
  for (const name of await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const filename = "uploads/" + folder + "/" + name;
    if (uploadedImagePattern.test(filename))
      files.push({ filename, file: path.join(directory, name) });
  }
}
console.log("Ảnh local hợp lệ:", files.length);
if (!apply) {
  console.log(
    "Chạy npm run images:migrate -- --apply để sao chép vào MongoDB trong MONGODB_URI. Không xóa file hoặc sửa bản ghi nội dung.",
  );
} else {
  const connection = await connectDB(loadEnvironment().get("MONGODB_URI"));
  try {
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, {
      bucketName: "images",
    });
    for (const { filename, file } of files) {
      const bytes = await readFile(file);
      const existing = await bucket.find({ filename }).limit(1).next();
      if (existing) {
        const chunks = [];
        for await (const chunk of bucket.openDownloadStream(existing._id))
          chunks.push(chunk);
        if (!Buffer.concat(chunks).equals(bytes))
          throw new Error(
            "Ảnh trùng đường dẫn nhưng khác nội dung: " + filename,
          );
        console.log("Đã có:", filename);
        continue;
      }
      const upload = bucket.openUploadStream(filename);
      try {
        await pipeline(Readable.from([bytes]), upload);
      } catch (error) {
        await upload.abort().catch(() => {});
        throw error;
      }
      console.log("Đã sao chép:", filename);
    }
  } finally {
    await connection.close();
  }
}
