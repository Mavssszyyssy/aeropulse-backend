const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const OtpRequest = require("../src/models/OtpRequest");
const env = require("../src/config/env");
const {
  login,
  resendLoginEmail,
  requestPasswordReset,
  requestOtp,
  resetPasswordWithCode,
} = require("../src/controllers/authController");
const { updateProfileById } = require("../src/controllers/userController");
const emailService = require("../src/utils/email");
const { hashVerificationCode } = require("../src/services/emailVerificationService");
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

test("the shared email exception is limited to the six exact demo accounts", async () => {
  assert.equal(SHARED_DEMO_ACCOUNTS.length, 6);
  assert.deepEqual(
    new Set(SHARED_DEMO_ACCOUNTS.map(({ accountKey }) => accountKey)),
    new Set([
      "superadmin.main",
      "admin.cavite",
      "admin.bulacan",
      "tech.main",
      "tech.cavite.carl",
      "tech.cavite.lebron",
    ]),
  );
  const keys = new Set();
  for (const account of SHARED_DEMO_ACCOUNTS) {
    const user = fixture(account);
    await user.validate();
    assert.equal(canUseSharedDemoEmail(user, SHARED_DEMO_EMAIL), true);
    assert.equal(user.emailIdentityKey, `shared-demo:${account.accountKey}`);
    keys.add(user.emailIdentityKey);
  }
  assert.equal(keys.size, 6);

  const impostor = fixture({ accountKey: "tech.cavite.other", role: "technician", branch: "Cavite" });
  await impostor.validate();
  assert.equal(canUseSharedDemoEmail(impostor, SHARED_DEMO_EMAIL), false);
  assert.equal(impostor.emailIdentityKey, `email:${SHARED_DEMO_EMAIL}`);

  const ordinaryA = new User({ name_first: "A", name_last: "Customer", email: "normal@example.com" });
  const ordinaryB = new User({ name_first: "B", name_last: "Customer", email: "normal@example.com" });
  assert.equal(buildEmailIdentityKey(ordinaryA), buildEmailIdentityKey(ordinaryB));
});

test("all staff demo accounts and customers receive separate account-bound email challenges", async (t) => {
  const demoUsers = SHARED_DEMO_ACCOUNTS.map((account, index) => fixture(account, {
    passwordHash: bcrypt.hashSync(`DemoPass${index + 1}!`, 4),
  }));
  const customer = new User({
    name_first: "Demo",
    name_last: "Customer",
    alias: "customer.email.challenge",
    username: "customer.email.challenge",
    role: "customer",
    email: "customer@example.com",
    passwordHash: bcrypt.hashSync("CustomerPass1!", 4),
  });
  const accounts = [...demoUsers, customer];
  assert.equal(new Set(accounts.map(({ id }) => id)).size, accounts.length);
  assert.deepEqual(new Set(accounts.map(({ role }) => role)), new Set(["superadmin", "admin", "technician", "customer"]));
  const created = [];
  t.mock.method(emailService, "canSendEmail", () => true);
  t.mock.method(emailService, "sendEmail", async () => {});
  t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => null }));
  t.mock.method(OtpRequest, "countDocuments", async () => 0);
  t.mock.method(OtpRequest, "create", async (record) => { created.push(record); return { ...record, _id: String(created.length) }; });

  t.mock.method(User, "findOne", async (query) => {
    const aliases = (query.$or || []).map((condition) => condition.alias).filter(Boolean);
    return accounts.find((account) => aliases.includes(account.alias)) || null;
  });

  for (const [index, user] of accounts.entries()) {
    const password = user.role === "customer" ? "CustomerPass1!" : `DemoPass${index + 1}!`;
    const res = response();
    await login({ body: { identifier: user.alias, password } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requiresEmailVerification, true);
    const challenge = jwt.verify(res.body.challengeToken, env.jwtSecret);
    assert.equal(challenge.purpose, "login_email_verification");
    assert.equal(challenge.sub, user.id);
    assert.ok(challenge.jti);
    assert.equal(created.at(-1).accountId, user.id);
    assert.equal(created.at(-1).challengeId, challenge.jti);
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

test("resending a sign-in code renews the same account-bound challenge", async (t) => {
  const account = fixture(SHARED_DEMO_ACCOUNTS[0], {
    security: { sessionVersion: 4 },
  });
  t.mock.method(User, "findById", async (id) => {
    assert.equal(String(id), account.id);
    return account;
  });
  t.mock.method(emailService, "canSendEmail", () => true);
  t.mock.method(emailService, "sendEmail", async () => {});
  t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => null }));
  t.mock.method(OtpRequest, "countDocuments", async () => 0);
  t.mock.method(OtpRequest, "create", async (record) => ({ ...record, _id: "resent" }));

  const originalChallenge = jwt.sign({
    purpose: "login_email_verification",
    sub: account.id,
    jti: "resend-challenge",
    securityVersion: 4,
  }, env.jwtSecret, { expiresIn: "1m" });
  const res = response();
  await resendLoginEmail({ body: { challengeToken: originalChallenge } }, res);

  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.challengeToken, originalChallenge);
  const renewed = jwt.verify(res.body.challengeToken, env.jwtSecret);
  assert.equal(renewed.sub, account.id);
  assert.equal(renewed.jti, "resend-challenge");
  assert.equal(renewed.securityVersion, 4);
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
  const recoveryOtp = {
    _id: "shared-recovery-code",
    codeHash: hashVerificationCode({
      accountId: carl.id,
      email: SHARED_DEMO_EMAIL,
      action: "password_reset",
      code,
    }),
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    lockedAt: null,
    verifiedAt: null,
    save: async () => {},
  };
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
    return { sort: async () => recoveryOtp };
  });
  t.mock.method(OtpRequest, "findOneAndUpdate", async (_query, update) => ({ ...recoveryOtp, verifiedAt: update.$set.verifiedAt }));
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
  await requestOtp({ body: { action: "register_email", channel: "email", email: SHARED_DEMO_EMAIL } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /reserved/i);
});

test("superadmin email editing preserves the target account session and permissions", async (t) => {
  const carlAccount = SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.carl");
  const lebronAccount = SHARED_DEMO_ACCOUNTS.find(({ accountKey }) => accountKey === "tech.cavite.lebron");
  const target = fixture(carlAccount, {
    email: "carl-before@example.com",
    passwordHash: "unchanged-password-hash",
    permissions: ["service:complete"],
    security: {
      sessionVersion: 7,
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
