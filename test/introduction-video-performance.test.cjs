const test = require("node:test");
const assert = require("node:assert/strict");

test("a new video chunk requires two database round trips, with no part pre-read", async () => {
  const { IntroductionVideoService, videoChunkSize } =
    await import("../src/services/introductionVideoService.js");
  const calls = [];
  const file = {
    _id: "upload",
    owner: "admin",
    status: "uploading",
    type: "video/mp4",
    size: videoChunkSize,
    count: 1,
    expiresAt: new Date(Date.now() + 86400000),
  };
  const files = {
    async findOneAndUpdate(filter, update, options) {
      calls.push("renew");
      assert.equal(filter.owner, "admin");
      assert.equal(filter.status, "uploading");
      assert.ok(filter.expiresAt.$gt instanceof Date);
      assert.ok(update.$set.expiresAt > new Date());
      assert.equal(options.returnDocument, "after");
      return file;
    },
    async findOne() {
      assert.fail("active upload metadata must not be read a second time");
    },
  };
  const parts = {
    async findOne() {
      assert.fail("new chunks must not wait for a preliminary database read");
    },
    async insertOne(part) {
      calls.push("insert");
      assert.equal(part.uploadId, "upload");
      assert.equal(part.index, 0);
      assert.equal(part.length, videoChunkSize);
      assert.equal(part.data.length, videoChunkSize);
      assert.match(part.digest, /^[a-f0-9]{64}$/);
    },
  };
  const service = new IntroductionVideoService({
    collection: (name) => (name === "introduction_videos" ? files : parts),
  });
  const bytes = Buffer.alloc(videoChunkSize);
  bytes.write("ftyp", 4);
  assert.deepEqual(await service.putPart("upload", 0, bytes, "admin"), {
    success: true,
  });
  assert.deepEqual(calls, ["renew", "insert"]);
});
