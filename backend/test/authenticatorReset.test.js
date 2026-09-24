const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const User = require("../src/models/User");
const env = require("../src/config/env");
const { resetTotpAuthenticator } = require("../src/controllers/securityController");
const { buildTotpSetup, encryptSecret } = require("../src/domain/accountSecurity");

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const buildAccount = async (role) => {
  const secret = buildTotpSetup({ accountName: `${role}-reset-test` }).secret;
  const user = new User({
    name_first: "Account",
    name_last: "Owner",
    alias: `${role}.reset.test`,
    role,
    passwordHash: await bcrypt.hash("CurrentPass1!", 4),
    security: {
      totpEnabled: true,
      totpSecretEncrypted: encryptSecret(secret),
      totpPendingSecretEncrypted: encryptSecret("OLDPENDINGSECRET"),
      recoveryCodeHashes: ["old-recovery-hash"],
      recoveryCodesRemaining: 1,
      sessionVersion: 7,
    },
  });
  return { user, secret };
};

for (const role of ["customer", "technician"]) {
  test(`${role} authenticator reset verifies the account and replaces its security session`, async (t) => {
    const { user, secret } = await buildAccount(role);
    let update;
    t.mock.method(User, "findById", () => ({ select: async () => user }));
    t.mock.method(User, "findOneAndUpdate", async (query, changes) => {
      update = { query, changes };
      user.security.totpEnabled = false;
      user.security.totpResetRequired = true;
      user.security.totpSecretEncrypted = "";
      user.security.totpPendingSecretEncrypted = "";
      user.security.recoveryCodeHashes = [];
      user.security.recoveryCodesRemaining = 0;
      user.security.sessionVersion = 8;
      return user;
    });

    const res = response();
    await resetTotpAuthenticator({
      authUser: user,
      body: {
        currentPassword: "CurrentPass1!",
        currentCode: speakeasy.totp({ secret, encoding: "base32" }),
      },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(update.query._id, user._id);
    assert.equal(update.query["security.sessionVersion"], 7);
    assert.deepEqual(update.changes.$set["security.recoveryCodeHashes"], []);
    assert.equal(res.body.user.security.totpSecretEncrypted, undefined);
    const token = jwt.verify(res.body.token, env.jwtSecret);
    assert.equal(token.sub, user.id);
    assert.equal(token.role, role);
    assert.equal(token.recovery, true);
    assert.equal(token.securityVersion, 8);
  });
}

test("authenticator reset rejects the wrong current password before changing MFA", async (t) => {
  const { user, secret } = await buildAccount("customer");
  let wrote = false;
  t.mock.method(User, "findById", () => ({ select: async () => user }));
  t.mock.method(User, "findOneAndUpdate", async () => { wrote = true; return user; });
  const res = response();
  await resetTotpAuthenticator({
    authUser: user,
    body: {
      currentPassword: "WrongPass1!",
      currentCode: speakeasy.totp({ secret, encoding: "base32" }),
    },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Current password is incorrect.");
  assert.equal(wrote, false);
  assert.equal(user.security.totpEnabled, true);
});

test("authenticator reset rejects the wrong TOTP code before changing MFA", async (t) => {
  const { user } = await buildAccount("technician");
  let wrote = false;
  t.mock.method(User, "findById", () => ({ select: async () => user }));
  t.mock.method(User, "findOneAndUpdate", async () => { wrote = true; return user; });
  const res = response();
  await resetTotpAuthenticator({
    authUser: user,
    body: { currentPassword: "CurrentPass1!", currentCode: "000000" },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Current authenticator code is incorrect.");
  assert.equal(wrote, false);
  assert.equal(user.security.totpEnabled, true);
});
