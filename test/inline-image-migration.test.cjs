const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { png } = require("./image-fixture.cjs");

test("inline image migration backs up data, verifies storage and preserves concurrent edits", async () => {
  const { migrateInlineImages } =
    await import("../scripts/migrate-inline-images.js");
  const mongo = await MongoMemoryServer.create();
  const connection = await mongoose
    .createConnection(mongo.getUri())
    .asPromise();
  const backupDirectory = await mkdtemp(
    path.join(tmpdir(), "inline-images-test-"),
  );
  const image = "data:image/png;base64," + png().toString("base64");
  const collection = connection.collection("news");
  try {
    await collection.insertOne({
      _id: "n1",
      title: "Original",
      image,
      updatedAt: "unchanged",
    });
    assert.equal((await migrateInlineImages(connection)).count, 1);
    assert.equal((await collection.findOne({ _id: "n1" })).image, image);
    await assert.rejects(
      migrateInlineImages(connection, {
        apply: true,
        backupDirectory,
        verifyImage: async () => {
          throw Error("Unavailable");
        },
      }),
    );
    assert.equal(
      await connection.collection("images.files").countDocuments(),
      0,
    );
    const result = await migrateInlineImages(connection, {
      apply: true,
      backupDirectory,
    });
    assert.equal(result.migrated, 1);
    const saved = await collection.findOne({ _id: "n1" });
    assert.match(saved.image, /^uploads\/news\//);
    assert.equal(saved.updatedAt, "unchanged");
    const backup = JSON.parse(await readFile(result.backupFile, "utf8"));
    assert.equal(backup.items[0].image, image);
    assert.equal(backup.items[0].replacement, saved.image);
    assert.equal(
      (await migrateInlineImages(connection, { apply: true, backupDirectory }))
        .migrated,
      0,
    );
    await collection.insertOne({ _id: "race", image });
    const raced = await migrateInlineImages(connection, {
      apply: true,
      backupDirectory,
      verifyImage: async () => {
        await collection.updateOne(
          { _id: "race" },
          { $set: { image: "https://cdn.example.com/new.png" } },
        );
      },
    });
    assert.equal(raced.migrated, 0);
    assert.equal(
      (await collection.findOne({ _id: "race" })).image,
      "https://cdn.example.com/new.png",
    );
    assert.equal(
      await connection.collection("images.files").countDocuments(),
      1,
    );
  } finally {
    await connection.close();
    await mongo.stop();
    assert.ok(
      path
        .resolve(backupDirectory)
        .startsWith(path.resolve(tmpdir()) + path.sep + "inline-images-test-"),
    );
    await rm(backupDirectory, { recursive: true, force: true });
  }
});
