const test = require("node:test");
const assert = require("node:assert/strict");

test("existing admin startup does not rehash or upsert credentials", async () => {
  const { AuthService } = await import("../src/services/authService.js");
  let writes = 0;
  const users = {
    init: async () => {},
    exists: async () => ({ _id: "existing" }),
    updateOne: async () => {
      writes++;
    },
  };
  const sessions = { init: async () => {} };
  const config = {
    get: (key) =>
      ({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "existing-long-password" })[
        key
      ],
  };
  const auth = new AuthService(users, sessions, {}, config);
  await auth.initialize();
  assert.equal(writes, 0);
  assert.equal(auth.dummyHash, undefined);
});
