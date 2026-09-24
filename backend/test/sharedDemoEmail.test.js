const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const OtpRequest = require("../src/models/OtpRequest");
const env = require("../src/config/env");
const {
  login,
  requestPasswordReset,
  resetPasswordWithCode,
  startRegistration,
} = require("../src/controllers/authController");
const { updateProfileById } = require("../src/controllers/userController");
const { encryptSecret } = require("../src/domain/accountSecurity");
const {
  SHARED_DEMO_ACCOUNTS,
  SHARED_DEMO_EMAIL,
  buildEmailIdentityKey,
  canUseSharedDemoEmail,
} = require("../src/domain/demoStaffPolicy");

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const fixture = (account, extra = {}) => new User({
  name_first: "Demo",
  name_last: account.accountKey,
  alias: account.accountKey,
  username: account.accountKey,
  role: account.role,
  assignedBranch: account.branch,
  email: SHARED_DEMO_EMAIL,
  ...extra,
});

test("the shared email exception is limited to the five exact demo accounts", async () => {
  assert.equal(SHARED_DEMO_ACCOUNTS.length, 5);
  const keys = new Set();
  for (const account of SHARED_DEMO_ACCOUNTS) {
    const user = fixture(account);
    await user.validate();
    assert.equal(canUseSharedDemoEmail(user, SHARED_DEMO_EMAIL), true);
    assert.equal(user.emailIdentityKey, `shared-demo:${account.accountKey}`);
    keys.add(user.emailIdentityKey);
  }
  assert.equal(keys.size, 5);

  const impostor = fixture({ accountKey: "tech.cavite.other", role: "technician", branch: "Cavite" });
  await impostor.validate();
  assert.equal(canUseSharedDemoEmail(impostor, SHARED_DEMO_EMAIL), false);
  assert.equal(impostor.emailIdentityKey, `email:${SHARED_DEMO_EMAIL}`);

  const ordinaryA = new User({ name_first: "A", name_last: "Customer", email: "normal@example.com" });
  const ordinaryB = new User({ name_first: "B", name_last: "Customer", email: "normal@example.com" });
  assert.equal(buildEmailIdentityKey(ordinaryA), buildEmailIdentityKey(ordinaryB));
});

test("accounts sharing the demo email still sign in by unique ID and receive account-bound MFA challenges", async (t) => {
  const carl = fixture(SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.carl"), {
    security: { totpEnabled: true, totpSecretEncrypted: encryptSecret("CARLSEPARATESECRET") },
  });
  const lebron = fixture(SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.lebron"), {
    security: { totpEnabled: true, totpSecretEncrypted: encryptSecret("LEBRONSEPARATESECRET") },
  });
  carl.passwordHash = await bcrypt.hash("CarlPass123!", 4);
  lebron.passwordHash = await bcrypt.hash("LebronPass123!", 4);
  assert.notEqual(carl.id, lebron.id);
  assert.notEqual(carl.security.totpSecretEncrypted, lebron.security.totpSecretEncrypted);

  t.mock.method(User, "findOne", async (query) => {
    const aliases = (query.$or || []).map((condition) => condition.alias).filter(Boolean);
    if (aliases.includes(carl.alias)) return carl;
    if (aliases.includes(lebron.alias)) return lebron;
    return null;
  });

  for (const [user, password] of [[carl, "CarlPass123!"], [lebron, "LebronPass123!"]]) {
    const res = response();
    await login({ body: { identifier: user.alias, password } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requiresTotp, true);
    const challenge = jwt.verify(res.body.challengeToken, env.jwtSecret);
    assert.equal(challenge.purpose, "login_totp");
    assert.equal(challenge.sub, user.id);
  }
});

test("sign-in rejects an email that resolves to more than one account", async (t) => {
  const accounts = SHARED_DEMO_ACCOUNTS.slice(0, 2).map((account) => fixture(account));
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "find", () => ({ limit: async () => accounts }));
  const res = response();
  await login({ body: { identifier: SHARED_DEMO_EMAIL, password: "Unused123!" } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.token, undefined);
  assert.match(res.body.message, /unique login ID/i);
});

test("shared demo email recovery requires an exact account login ID", async () => {
  const res = response();
  await requestPasswordReset({ body: { identifier: SHARED_DEMO_EMAIL } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /unique login ID/i);
});

test("shared demo email password reset remains bound to the selected account ID", async (t) => {
  const code = "123456";
  const carl = fixture(SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.carl"), {
    passwordHash: await bcrypt.hash("OldPass123!", 4),
    security: { sessionVersion: 3 },
  });
  const previousPasswordHash = carl.passwordHash;
  t.mock.method(User, "findOne", async (query) => {
    assert.deepEqual(query, {
      $or: [
        { alias: "tech.cavite.carl" },
        { username: "tech.cavite.carl" },
      ],
    });
    return carl;
  });
  t.mock.method(OtpRequest, "findOne", (query) => {
    assert.equal(query.accountId, carl.id);
    assert.equal(query.email, SHARED_DEMO_EMAIL);
    return {
      sort: async () => ({
        codeHash: crypto.createHash("sha256").update(code).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        verifiedAt: null,
        save: async () => {},
      }),
    };
  });
  t.mock.method(carl, "save", async () => carl);

  const res = response();
  await resetPasswordWithCode({
    body: {
      identifier: SHARED_DEMO_EMAIL,
      accountLoginId: "tech.cavite.carl",
      code,
      newPassword: "UpdatedPass2!",
      channel: "email",
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, "Success");
  assert.notEqual(carl.passwordHash, previousPasswordHash);
  assert.equal(carl.security.sessionVersion, 4);
});

test("public customer registration cannot claim the reserved shared demo email", async () => {
  const res = response();
  await startRegistration({ body: { email: SHARED_DEMO_EMAIL } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.errors.email, /reserved/i);
});

test("superadmin email editing preserves the target account security configuration", async (t) => {
  const carlAccount = SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.carl");
  const lebronAccount = SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.lebron");
  const target = fixture(carlAccount, {
    email: "carl-before@example.com",
    passwordHash: "unchanged-password-hash",
    permissions: ["service:complete"],
    security: {
      sessionVersion: 7,
      totpEnabled: true,
      totpSecretEncrypted: encryptSecret("CARLSEPARATESECRET"),
      totpVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      recoveryCodeHashes: ["unchanged-recovery-hash"],
      recoveryCodesRemaining: 1,
    },
  });
  const existingSharedEmailAccount = fixture(lebronAccount);
  const securityBefore = target.security.toObject();
  const passwordBefore = target.passwordHash;
  const permissionsBefore = [...target.permissions];
  t.mock.method(User, "findById", async () => target);
  t.mock.method(User, "findOne", async () => existingSharedEmailAccount);
  t.mock.method(target, "save", async () => target);

  const res = response();
  await updateProfileById({
    authUser: fixture(SHARED_DEMO_ACCOUNTS[0]),
    params: { id: target.id },
    body: { email: SHARED_DEMO_EMAIL },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(target.email, SHARED_DEMO_EMAIL);
  assert.deepEqual(target.security.toObject(), securityBefore);
  assert.equal(target.passwordHash, passwordBefore);
  assert.deepEqual(target.permissions, permissionsBefore);
});
