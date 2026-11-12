const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
let mongo,
  runtime,
  app,
  server,
  base,
  calls = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cookie = (response, name) =>
  response.headers
    .getSetCookie()
    .find((v) => v.startsWith(name + "="))
    .split(";")[0];
async function login() {
  const response = await fetch(base + "/auth/zalo/login", {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  return {
    response,
    location,
    state: location.searchParams.get("state"),
    cookie: cookie(response, "tanson_zalo_oauth"),
  };
}
const callback = (flow, query = "code=valid", browser = flow.cookie) =>
  fetch(base + "/auth/zalo/callback?state=" + flow.state + "&" + query, {
    headers: { Cookie: browser },
  });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("zalo_oauth_isolated_test");
  process.env.JWT_SECRET = randomBytes(48).toString("hex");
  process.env.ADMIN_USERNAME = "";
  process.env.ADMIN_PASSWORD = "";
  process.env.ZALO_APP_ID = "123456789";
  process.env.ZALO_APP_SECRET = "provider-secret";
  process.env.ZALO_REDIRECT_URI =
    "https://behdntanson.vercel.app/api/v1/auth/zalo/callback";
  runtime = await import("../src/main.js");
});
test.beforeEach(async () => {
  app = await runtime.createApp();
  server = await runtime.listen(app, 0, "127.0.0.1");
  base = "http://127.0.0.1:" + server.address().port + "/api/v1";
  app.locals.services.zaloOAuth.transport = async (url, options) => {
    calls.push({ url, options });
    assert.equal(url, "https://oauth.zaloapp.com/v4/access_token");
    assert.equal(options.headers.secret_key, "provider-secret");
    assert.equal(options.body.get("grant_type"), "authorization_code");
    if (options.body.get("code") === "offline") throw Error("offline");
    return {
      ok: true,
      json: async () =>
        options.body.get("code") === "bad"
          ? { error: -1 }
          : {
              access_token: "provider-access-token",
              refresh_token: "provider-refresh-token",
              expires_in: 3600,
            },
    };
  };
  app.locals.services.memberAccess.transport = async (_url, options) => {
    assert.equal(options.headers.access_token, "provider-access-token");
    return {
      ok: true,
      json: async () => ({
        id: "123456789",
        name: "Hội viên Zalo",
        picture: { data: { url: "https://example.com/avatar.jpg" } },
      }),
    };
  };
});
test.afterEach(async () => {
  if (app) await runtime.closeApp(app, server);
});
test.after(async () => {
  if (mongo) await mongo.stop();
});

test("OAuth redirects with fresh PKCE and binds callback to the browser", async () => {
  const a = await login(),
    b = await login();
  assert.equal(a.location.origin, "https://oauth.zaloapp.com");
  assert.equal(a.location.searchParams.get("app_id"), "123456789");
  assert.equal(
    a.location.searchParams.get("redirect_uri"),
    process.env.ZALO_REDIRECT_URI,
  );
  assert.notEqual(a.state, b.state);
  assert.match(a.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(a.response.headers.get("set-cookie"), /Secure/);
  assert.match(a.response.headers.get("set-cookie"), /SameSite=Lax/);
  const before = calls.length;
  assert.equal((await callback(a, "code=valid", b.cookie)).status, 401);
  assert.equal((await callback(a, "code=valid", "")).status, 401);
  assert.equal(calls.length, before);
  const response = await callback(a);
  assert.equal(response.status, 200);
  assert.equal(
    createHash("sha256")
      .update(calls.at(-1).options.body.get("code_verifier"))
      .digest("base64url"),
    a.location.searchParams.get("code_challenge"),
  );
  assert.equal((await callback(a)).status, 401);
});

test("callback persists encrypted session across service instances without exposing provider tokens", async () => {
  const flow = await login();
  const response = await callback(flow);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.user.id, "123456789");
  assert.equal(body.data.linked, false);
  assert.doesNotMatch(
    JSON.stringify(body),
    /provider-access-token|provider-refresh-token|provider-secret/,
  );
  const sessionCookie = cookie(response, "tanson_zalo_session");
  const sessionId = sessionCookie.split("=")[1];
  const record = await app.locals.models.zaloOAuth.sessions
    .findById(hash(sessionId))
    .lean();
  assert.ok(record);
  assert.doesNotMatch(record.encryptedToken, /provider-access-token/);
  const { ZaloOAuthService } =
    await import("../src/services/zaloOAuthService.js");
  const original = app.locals.services.zaloOAuth;
  const another = new ZaloOAuthService(
    original.models,
    original.config,
    original.memberAccess,
  );
  assert.equal(await another.accessToken(sessionId), "provider-access-token");
  const headers = { Cookie: sessionCookie };
  assert.equal((await fetch(base + "/auth/zalo/me", { headers })).status, 200);
  assert.equal(
    (await fetch(base + "/member/identity", { headers })).status,
    200,
  );
  assert.equal(
    (await fetch(base + "/member/members", { headers })).status,
    403,
  );
  await app.locals.models.members.create({
    _id: "oauth-member",
    name: "Hội viên OAuth",
    company: "Doanh nghiệp",
    joinedAt: "2026-01-01",
    status: "active",
    zaloUserId: "123456789",
  });
  assert.equal(
    (await fetch(base + "/member/members", { headers })).status,
    200,
  );
  await app.locals.models.members.updateOne(
    { _id: "oauth-member" },
    { $set: { status: "inactive" } },
  );
  assert.equal(
    (await fetch(base + "/member/members", { headers })).status,
    403,
  );
  assert.equal((await fetch(base + "/auth/me", { headers })).status, 401);
  assert.equal(
    (
      await fetch(base + "/auth/zalo/logout", {
        method: "POST",
        headers: { ...headers, Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + "/auth/zalo/logout", { method: "POST", headers }))
      .status,
    200,
  );
  assert.equal((await fetch(base + "/auth/zalo/me", { headers })).status, 401);
});

test("expired states, cancelled consent and provider errors cannot create a session", async () => {
  const expired = await login();
  await app.locals.models.zaloOAuth.flows.updateOne(
    { _id: hash(expired.state) },
    { $set: { expiresAt: new Date(0) } },
  );
  assert.equal((await callback(expired)).status, 401);
  const denied = await login();
  assert.equal((await callback(denied, "error=access_denied")).status, 401);
  assert.equal((await callback(denied)).status, 401);
  const bad = await login();
  assert.equal((await callback(bad, "code=bad")).status, 401);
  const offline = await login();
  assert.equal((await callback(offline, "code=offline")).status, 503);
});

test("expired sessions are rejected before TTL cleanup; missing OAuth config leaves other APIs running", async () => {
  const response = await callback(await login());
  const sessionCookie = cookie(response, "tanson_zalo_session");
  await app.locals.models.zaloOAuth.sessions.updateOne(
    { _id: hash(sessionCookie.split("=")[1]) },
    { $set: { expiresAt: new Date(0) } },
  );
  assert.equal(
    (
      await fetch(base + "/auth/zalo/me", {
        headers: { Cookie: sessionCookie },
      })
    ).status,
    401,
  );
  const saved = process.env.ZALO_APP_SECRET;
  try {
    delete process.env.ZALO_APP_SECRET;
    assert.equal(
      (await fetch(base + "/auth/zalo/login", { redirect: "manual" })).status,
      503,
    );
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    process.env.ZALO_APP_SECRET = saved;
  }
});
