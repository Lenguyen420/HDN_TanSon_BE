const test = require("node:test");
const assert = require("node:assert/strict");

test("admin bootstrap accepts the configured six-character password and hashes it", async () => {
  const { AuthService } = await import("../src/services/authService.js");
  const { verifyPassword } = await import("../src/utils/password.js");
  let created;
  const users = {
    init: async () => {},
    exists: async () => null,
    updateOne: async (filter, update) => {
      created = update.$setOnInsert;
    },
  };
  const config = {
    get: (key) =>
      ({ ADMIN_USERNAME: "admin_tanson", ADMIN_PASSWORD: "123456" })[key],
  };
  await new AuthService(
    users,
    { init: async () => {} },
    {},
    config,
  ).initialize();
  assert.equal(created.username, "admin_tanson");
  assert.equal(created.role, "SUPER_ADMIN");
  assert.notEqual(created.passwordHash, "123456");
  assert.equal(await verifyPassword("123456", created.passwordHash), true);
  assert.equal(
    await verifyPassword("wrong-password", created.passwordHash),
    false,
  );
});
