const assert = require("node:assert/strict");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const OtpRequest = require("../src/models/OtpRequest");
const env = require("../src/config/env");
const { login, verifyLoginEmail, resendLoginEmail } = require("../src/controllers/authController");

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function assertLockout(result, maxSeconds = 900) {
  assert.equal(result.statusCode, 429);
  assert.equal(result.body.code, "LOGIN_LOCKED");
  assert.ok(result.body.retryAfterSeconds > 0 && result.body.retryAfterSeconds <= maxSeconds);
}

test("the attempt that locks password sign-in immediately returns the deadline", async (t) => {
  const user = { failedLoginAttempts: 3, save: t.mock.fn(async () => {}) };
  t.mock.method(User, "findOne", async () => user);
  const request = { body: { identifier: "account.alias", password: "Incorrect1!" } };

  const beforeLockout = response();
  await login(request, beforeLockout);
  assert.equal(beforeLockout.statusCode, 401);
  assert.equal(user.failedLoginAttempts, 4);

  const firstLocked = response();
  await login(request, firstLocked);
  assertLockout(firstLocked);
  assert.equal(user.failedLoginAttempts, 0);

  user.lockoutUntil = new Date(Date.now() + 30_000);
  const stillLocked = response();
  await login(request, stillLocked);
  assertLockout(stillLocked, 30);
  assert.equal(user.save.mock.callCount(), 2);

  user.lockoutUntil = new Date(Date.now() - 1000);
  const expired = response();
  await login(request, expired);
  assert.equal(expired.statusCode, 401);
  assert.equal(user.failedLoginAttempts, 1);
});

test("the account lockout blocks sign-in code verification and resend", async (t) => {
  const user = {
    id: "account-1",
    email: "account@example.com",
    failedLoginAttempts: 4,
    security: { sessionVersion: 0 },
    save: t.mock.fn(async () => {}),
  };
  t.mock.method(User, "findById", async () => user);
  const findOtp = t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => null }));
  const challengeToken = jwt.sign({
    purpose: "login_email_verification",
    sub: user.id,
    jti: "challenge-1",
    securityVersion: 0,
  }, env.jwtSecret, { expiresIn: "5m" });
  const request = { body: { challengeToken, code: "123456" } };

  const firstLocked = response();
  await verifyLoginEmail(request, firstLocked);
  assertLockout(firstLocked);
  findOtp.mock.resetCalls();

  const verifyResult = response();
  await verifyLoginEmail(request, verifyResult);
  assertLockout(verifyResult);
  const resendResult = response();
  await resendLoginEmail(request, resendResult);
  assertLockout(resendResult);
  assert.equal(findOtp.mock.callCount(), 0);
  assert.equal(user.save.mock.callCount(), 1);
});
