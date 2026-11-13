const test = require("node:test");
const assert = require("node:assert/strict");

test("local startup rejects an occupied port instead of returning a non-listening server", async () => {
  const { default: express } = await import("express");
  const { listen } = await import("../src/main.js");
  const server = await listen(express(), 0, "127.0.0.1");
  try {
    await assert.rejects(
      listen(express(), server.address().port, "127.0.0.1"),
      (error) => error.code === "EADDRINUSE",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
