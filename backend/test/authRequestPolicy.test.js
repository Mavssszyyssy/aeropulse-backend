const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const { createAuthRateLimit, createAuthSessionMiddleware } = require("../src/middleware/authRequestPolicy");
const { createMemoryRateLimit } = require("../src/middleware/requestRateLimit");

const request = (path, body = {}, ip = "192.0.2.1", method = "POST") => ({
  method, path, body, ip, headers: {},
});
const run = (middleware, req) => {
  const result = { statusCode: 200, headers: {}, passed: false };
  const res = {
    set(key, value) { result.headers[key] = value; return this; },
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware(req, res, () => { result.passed = true; });
  return result;
};
const challenge = (account, device) => jwt.sign({
  purpose: "login_email_verification", sub: account, jti: device,
}, env.jwtSecret, { expiresIn: "5m" });

test("startup, cart and draft traffic never exhaust the sign-in budget", () => {
  const limit = createAuthRateLimit();
  for (let i = 0; i < 1000; i += 1) {
    for (const path of ["/me", "/session", "/session/cart", "/session/registration", "/logout"]) {
      assert.equal(run(limit, request(path, {}, "192.0.2.11", path === "/me" || path === "/session" ? "GET" : "POST")).passed, true);
    }
  }
  assert.equal(run(limit, request("/login", { identifier: "customer" }, "192.0.2.11")).passed, true);
});

test("many web/mobile users behind one network have independent sign-in and code limits", async () => {
  const limit = createAuthRateLimit();
  await Promise.all(Array.from({ length: 100 }, async (_, i) => {
    const ip = "192.0.2.12";
    assert.equal(run(limit, request("/login", { identifier: `customer.${i}` }, ip)).passed, true);
    assert.equal(run(limit, request("/login/verify-email", { challengeToken: challenge(`customer-${i}`, "web") }, ip)).passed, true);
    assert.equal(run(limit, request("/login/verify-email", { challengeToken: challenge(`customer-${i}`, "mobile") }, ip)).passed, true);
  }));
});

test("exhausting a challenge or account budget does not block another user or device", () => {
  const limit = createAuthRateLimit();
  const ip = "192.0.2.13";
  const firstDevice = request("/login/verify-email", { challengeToken: challenge("same-account", "web") }, ip);
  for (let i = 0; i < 10; i += 1) assert.equal(run(limit, firstDevice).passed, true);
  const blocked = run(limit, firstDevice);
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.body.retryAfterSeconds > 0);
  assert.equal(blocked.headers["Retry-After"], String(blocked.body.retryAfterSeconds));
  assert.equal(run(limit, request("/login/verify-email", { challengeToken: challenge("same-account", "mobile") }, ip)).passed, true);
  for (let i = 0; i < 30; i += 1) assert.equal(run(limit, request("/login", { identifier: "first" }, ip)).passed, true);
  assert.equal(run(limit, request("/LOGIN/", { identifier: " FIRST " }, ip)).statusCode, 429);
  assert.equal(run(limit, request("/login", { identifier: "second" }, ip)).passed, true);
});

test("forged challenges and untrusted forwarding headers cannot evade limits", () => {
  const limit = createAuthRateLimit();
  for (let i = 0; i < 11; i += 1) {
    const req = request("/login/verify-email", {
      challengeToken: jwt.sign({ purpose: "login_email_verification", sub: `user-${i}`, jti: `device-${i}` }, "untrusted-signing-key"),
    }, "192.0.2.14");
    const result = run(limit, req);
    assert.equal(result.statusCode, i < 10 ? 200 : 429);
  }
  const generic = createMemoryRateLimit({ scope: "trusted-proxy-test", max: 1, windowMs: 60_000, message: "Limited" });
  assert.equal(run(generic, { ...request("/"), headers: { "x-forwarded-for": "198.51.100.1" } }).passed, true);
  assert.equal(run(generic, { ...request("/"), headers: { "x-forwarded-for": "198.51.100.2" } }).statusCode, 429);
});

test("a network-wide credential flood is still bounded", () => {
  const limit = createAuthRateLimit();
  for (let i = 0; i < 600; i += 1) {
    assert.equal(run(limit, request("/login", { identifier: `flood-${i}` }, "192.0.2.15")).passed, true);
  }
  assert.equal(run(limit, request("/login", { identifier: "one-more" }, "192.0.2.15")).statusCode, 429);
  assert.equal(run(limit, request("/me", {}, "192.0.2.15", "GET")).passed, true);
});

test("token login and startup do not load the Mongo cookie-session store", () => {
  const touched = [];
  const middleware = createAuthSessionMiddleware((req, _res, next) => { touched.push(req.path); next(); });
  for (const path of ["/me", "/login", "/login/verify-email", "/login/resend-email", "/forgot-password", "/reset-password", "/check-alias"]) {
    assert.equal(run(middleware, request(path)).passed, true);
  }
  assert.deepEqual(touched, []);
  for (const path of ["/register", "/request-otp", "/verify-otp", "/session", "/session/registration", "/session/cart", "/logout"]) {
    assert.equal(run(middleware, request(path)).passed, true);
  }
  assert.equal(touched.length, 7);
  assert.equal(run(middleware, request("/SESSION/CART/")).passed, true);
  assert.equal(touched.length, 8);
});
