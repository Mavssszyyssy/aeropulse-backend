const test = require("node:test");
const assert = require("node:assert/strict");
const speakeasy = require("speakeasy");
const User = require("../src/models/User");
const {
  isRecoveryRequestAllowed,
  isTotpEnrollmentRequestAllowed,
  requireAuth,
} = require("../src/middleware/auth");
const { requiresTotpEnrollment, roleRequiresTotp } = require("../src/domain/accountSecurityPolicy");
const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const { signUserAccessToken } = require("../src/utils/token");
const {
  buildTotpSetup,
  decryptSecret,
  encryptSecret,
  findRecoveryCodeIndex,
  generateOtpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} = require("../src/domain/accountSecurity");

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("OTP generation always returns a secure six-digit value", () => {
  const values = new Set(Array.from({ length: 100 }, generateOtpCode));
  assert.equal(values.size > 90, true);
  for (const value of values) assert.match(value, /^\d{6}$/);
});

test("recovery codes are unique, normalized, and one-way hashed", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 6);
  assert.equal(new Set(codes).size, 6);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
  assert.equal(normalizeRecoveryCode(` ${codes[0].toLowerCase()} `), codes[0]);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase()));
  assert.notEqual(hashRecoveryCode(codes[0]), codes[0]);
  const hashes = codes.map(hashRecoveryCode);
  const matchIndex = findRecoveryCodeIndex(hashes, codes[2]);
  assert.equal(matchIndex, 2);
  hashes.splice(matchIndex, 1);
  assert.equal(findRecoveryCodeIndex(hashes, codes[2]), -1);
});

test("authenticator secrets are encrypted at rest and verify real TOTP codes", () => {
  const setup = buildTotpSetup({ accountName: "customer@example.com" });
  const encrypted = encryptSecret(setup.secret);
  assert.notEqual(encrypted.includes(setup.secret), true);
  assert.equal(decryptSecret(encrypted), setup.secret);
  const token = speakeasy.totp({ secret: setup.secret, encoding: "base32" });
  assert.equal(verifyTotpCode({ secret: setup.secret, code: token }), true);
  assert.equal(verifyTotpCode({ secret: setup.secret, code: "12345" }), false);
});

test("serialized accounts never expose authenticator secrets or recovery hashes", () => {
  const user = new User({
    name_first: "Security",
    name_last: "Test",
    alias: `security.test.${Date.now()}`,
    security: {
      totpEnabled: true,
      totpSecretEncrypted: "encrypted-secret",
      totpPendingSecretEncrypted: "pending-secret",
      recoveryCodeHashes: ["private-hash"],
      recoveryCodesRemaining: 1,
    },
  });
  const serialized = user.toJSON();
  assert.equal(serialized.security.totpEnabled, true);
  assert.equal(serialized.security.recoveryCodesRemaining, 1);
  assert.equal("totpSecretEncrypted" in serialized.security, false);
  assert.equal("totpPendingSecretEncrypted" in serialized.security, false);
  assert.equal("recoveryCodeHashes" in serialized.security, false);
});

test("recovery sessions can only access authenticator setup and session hydration", () => {
  assert.equal(isRecoveryRequestAllowed("/api/security/totp/setup"), true);
  assert.equal(isRecoveryRequestAllowed("/api/security/totp/verify?source=recovery"), true);
  assert.equal(isRecoveryRequestAllowed("/api/auth/me"), true);
  assert.equal(isRecoveryRequestAllowed("/api/auth/logout"), true);
  assert.equal(isRecoveryRequestAllowed("/api/orders/me"), false);
  assert.equal(isRecoveryRequestAllowed("/api/users/profile"), false);
});

test("customers and operational staff must enroll an authenticator before normal API access", () => {
  for (const role of ["customer", "technician", "admin", "superadmin"]) {
    assert.equal(roleRequiresTotp(role), true);
    assert.equal(requiresTotpEnrollment({ role, security: { totpEnabled: false } }), true);
    assert.equal(requiresTotpEnrollment({ role, security: { totpEnabled: true } }), false);
    assert.equal(requiresTotpEnrollment({ role, security: { totpEnabled: true, totpResetRequired: true } }), true);
  }
  assert.equal(roleRequiresTotp("manager"), false);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/security/totp/setup"), true);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/security/totp/verify"), true);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/auth/me"), true);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/auth/logout"), true);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/users/password"), true);
  assert.equal(isTotpEnrollmentRequestAllowed("/api/orders/me"), false);
});

test("challenge and incomplete tokens cannot be used as signed-in sessions", async () => {
  for (const payload of [{ sub: 'qa-user', role: 'customer', purpose: 'login_totp' }, { sub: 'qa-user' }, { role: 'customer' }]) {
    let status;
    let body;
    const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await requireAuth({ headers: { authorization: `Bearer ${jwt.sign(payload, env.jwtSecret)}` }, method: 'GET', originalUrl: '/api/users/profile' }, response, () => assert.fail('Token must not grant access'));
    assert.equal(status, 401);
    assert.match(body.message, /verified sign-in session/);
  }
});

test("authenticated staff without TOTP can reach setup but not operational APIs", async (t) => {
  const user = new User({
    name_first: "Enrollment",
    name_last: "Guard",
    role: "admin",
    assignedBranch: "Cavite",
    activeBranch: "Cavite",
    security: { totpEnabled: false, sessionVersion: 0 },
  });
  const query = {
    then(resolve, reject) { return Promise.resolve(user).then(resolve, reject); },
    select() { return { lean: async () => user.toObject() }; },
  };
  t.mock.method(User, "findById", () => query);
  const token = signUserAccessToken(user);
  const request = (path) => ({
    headers: { authorization: `Bearer ${token}` },
    method: "GET",
    originalUrl: path,
  });

  let nextCalled = false;
  const blocked = response();
  await requireAuth(request("/api/orders"), blocked, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.code, "TOTP_SETUP_REQUIRED");
  assert.equal(blocked.body.requiresTotpSetup, true);

  const allowed = response();
  await requireAuth(request("/api/security/status"), allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
