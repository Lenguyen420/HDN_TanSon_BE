const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

test("default trade categories persist once and preserve admin changes and deletions", async () => {
  const mongo = await MongoMemoryServer.create();
  const connection = await mongoose
    .createConnection(mongo.getUri("trade_seed_test"))
    .asPromise();
  try {
    const { seedTradeCategories } =
      await import("../src/services/tradeCategorySeed.js");
    const categories = connection.db.collection("trade_categories");
    await categories.createIndex({ code: 1 }, { unique: true });
    assert.deepEqual(await seedTradeCategories(categories), {
      added: 5,
      existing: 0,
    });
    assert.equal(
      (await categories.findOne({ code: "PROMOTION" }))
        .requiresPromotionDetails,
      true,
    );
    await categories.updateOne(
      { code: "PRODUCTS" },
      { $set: { name: "Tên đã chỉnh", isActive: false, version: 3 } },
    );
    await categories.updateOne(
      { code: "BUY" },
      { $set: { deletedAt: new Date() } },
    );
    assert.deepEqual(await seedTradeCategories(categories), {
      added: 0,
      existing: 5,
    });
    assert.equal(await categories.countDocuments(), 5);
    const edited = await categories.findOne({ code: "PRODUCTS" });
    assert.equal(edited.name, "Tên đã chỉnh");
    assert.equal(edited.isActive, false);
    assert.equal(edited.version, 3);
    assert.ok((await categories.findOne({ code: "BUY" })).deletedAt);
  } finally {
    await connection.close();
    await mongo.stop();
  }
});
