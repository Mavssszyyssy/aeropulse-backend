const test = require("node:test");
const assert = require("node:assert/strict");
const OtpRequest = require("../src/models/OtpRequest");
const emailService = require("../src/utils/email");
const {
  createEmailVerification,
  hashVerificationCode,
  OTP_TTL_MINUTES,
  verifyEmailCode,
} = require("../src/services/emailVerificationService");

test("login email verification is account-bound, hashed, expiring, and single-use", async (t) => {
  const saved = [];
  const challengeId = "login-challenge-a";
  t.mock.method(emailService, "canSendEmail", () => true);
  t.mock.method(emailService, "sendEmail", async ({ to, text }) => {
    const code = text.match(/Verification code: (\d{6})/)?.[1];
    assert.ok(code);
    saved.sentCode = code;
    assert.equal(to, "shared@example.com");
  });
  t.mock.method(OtpRequest, "findOne", (query) => ({
    sort: async () => saved.filter((item) => Object.entries(query).every(([key, value]) => item[key] === value)).at(-1) || null,
  }));
  t.mock.method(OtpRequest, "countDocuments", async () => 0);
  t.mock.method(OtpRequest, "create", async (record) => {
    const item = { ...record, _id: String(saved.length + 1), attempts: 0, lockedAt: null, verifiedAt: null, save: async () => {} };
    saved.push(item);
    return item;
  });
  t.mock.method(OtpRequest, "findOneAndUpdate", async (query, update) => {
    const item = saved.find((entry) => entry._id === String(query._id));
    if (!item || item.verifiedAt || item.lockedAt || item.codeHash !== query.codeHash) return null;
    item.verifiedAt = update.$set.verifiedAt;
    return item;
  });

  await createEmailVerification({ accountId: "account-a", challengeId, email: "shared@example.com", action: "login_verification" });
  assert.notEqual(saved[0].codeHash, saved.sentCode);
  assert.equal(saved[0].codeHash, hashVerificationCode({
    accountId: "account-a",
    challengeId,
    email: "shared@example.com",
    action: "login_verification",
    code: saved.sentCode,
  }));
  assert.ok(saved[0].expiresAt > new Date());

  assert.deepEqual(await verifyEmailCode({ accountId: "account-b", challengeId, email: "shared@example.com", action: "login_verification", code: saved.sentCode }), { ok: false, reason: "not_found" });
  assert.deepEqual(await verifyEmailCode({ accountId: "account-a", challengeId: "another-challenge", email: "shared@example.com", action: "login_verification", code: saved.sentCode }), { ok: false, reason: "not_found" });
  const [verified, duplicate] = await Promise.all([
    verifyEmailCode({ accountId: "account-a", challengeId, email: "shared@example.com", action: "login_verification", code: saved.sentCode }),
    verifyEmailCode({ accountId: "account-a", challengeId, email: "shared@example.com", action: "login_verification", code: saved.sentCode }),
  ]);
  assert.deepEqual([verified.ok, duplicate.ok].sort(), [false, true]);
  assert.ok(saved[0].verifiedAt);
  assert.deepEqual(await verifyEmailCode({ accountId: "account-a", challengeId, email: "shared@example.com", action: "login_verification", code: saved.sentCode }), { ok: false, reason: "not_found" });
});

test("the full advertised lifetime starts after email dispatch is accepted", async (t) => {
  let created;
  let expiresBeforeDispatch;
  t.mock.method(emailService, "canSendEmail", () => true);
  t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => null }));
  t.mock.method(OtpRequest, "countDocuments", async () => 0);
  t.mock.method(OtpRequest, "create", async (record) => {
    created = {
      ...record,
      _id: "dispatch-window",
      async save() { return this; },
    };
    expiresBeforeDispatch = created.expiresAt.getTime();
    return created;
  });
  t.mock.method(emailService, "sendEmail", async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  const { otpRequest } = await createEmailVerification({
    accountId: "account-a",
    email: "person@example.com",
    action: "password_reset",
  });

  assert.ok(otpRequest.expiresAt.getTime() > expiresBeforeDispatch);
  assert.equal(
    otpRequest.expiresAt.getTime() - otpRequest.requestedAt.getTime(),
    OTP_TTL_MINUTES * 60 * 1000,
  );
});

test("resending does not expire an earlier code before its own five-minute window", async (t) => {
  const firstRequestedAt = new Date(Date.now() - 31_000);
  const scope = {
    accountId: "account-a",
    challengeId: "resend-challenge",
    email: "person@example.com",
    action: "login_verification",
    channel: "email",
  };
  const records = ["111111", "222222"].map((code, index) => ({
    ...scope,
    _id: `resend-${index + 1}`,
    codeHash: hashVerificationCode({ ...scope, code }),
    requestedAt: index === 0 ? firstRequestedAt : new Date(),
    createdAt: index === 0 ? firstRequestedAt : new Date(),
    expiresAt: new Date((index === 0 ? firstRequestedAt.getTime() : Date.now()) + 5 * 60 * 1000),
    attempts: 0,
    lockedAt: null,
    verifiedAt: null,
    async save() { return this; },
  }));

  t.mock.method(OtpRequest, "findOne", (query) => ({
    sort: async () => records
      .filter((record) => !record.verifiedAt)
      .filter((record) => Object.entries(query).every(([key, value]) => record[key] === value))
      .at(-1) || null,
  }));
  t.mock.method(OtpRequest, "findOneAndUpdate", async (query, update) => {
    const record = records.find((item) => item._id === String(query._id));
    if (!record || record.verifiedAt || record.lockedAt || record.codeHash !== query.codeHash) return null;
    record.verifiedAt = update.$set.verifiedAt;
    return record;
  });

  const result = await verifyEmailCode({
    accountId: scope.accountId,
    challengeId: scope.challengeId,
    email: scope.email,
    action: scope.action,
    code: "111111",
  });

  assert.equal(result.ok, true);
  assert.equal(result.otpRequest._id, "resend-1");
  assert.ok(Date.now() - result.otpRequest.requestedAt.getTime() >= 30_000);
  assert.ok(records[0].verifiedAt);
  assert.equal(records[1].verifiedAt, null);
});

test("wrong email codes are atomically limited and an expired code cannot be consumed", async (t) => {
  const validCode = "654321";
  const challengeId = "attempt-challenge";
  const otp = {
    _id: "attempt-limited",
    accountId: "account-a",
    challengeId,
    email: "person@example.com",
    action: "login_verification",
    channel: "email",
    codeHash: hashVerificationCode({
      accountId: "account-a",
      challengeId,
      email: "person@example.com",
      action: "login_verification",
      code: validCode,
    }),
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    lockedAt: null,
    verifiedAt: null,
    async save() { return this; },
  };
  t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => otp }));
  t.mock.method(OtpRequest, "findOneAndUpdate", async (query, update) => {
    if (otp.verifiedAt || otp.lockedAt || otp.attempts >= query.attempts.$lt) return null;
    if (update.$inc?.attempts) otp.attempts += update.$inc.attempts;
    if (update.$set?.lastAttemptAt) otp.lastAttemptAt = update.$set.lastAttemptAt;
    return otp;
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await verifyEmailCode({
      accountId: "account-a",
      challengeId,
      email: "person@example.com",
      action: "login_verification",
      code: "000000",
    });
    assert.equal(result.reason, "invalid");
  }
  const locked = await verifyEmailCode({
    accountId: "account-a",
    challengeId,
    email: "person@example.com",
    action: "login_verification",
    code: "000000",
  });
  assert.equal(locked.reason, "locked");
  assert.equal(otp.attempts, 5);
  assert.ok(otp.lockedAt);

  otp.lockedAt = null;
  otp.attempts = 0;
  otp.expiresAt = new Date(Date.now() - 1);
  const expired = await verifyEmailCode({
    accountId: "account-a",
    challengeId,
    email: "person@example.com",
    action: "login_verification",
    code: validCode,
  });
  assert.equal(expired.reason, "expired");
  assert.equal(otp.verifiedAt, null);
});

test("email verification resend cooldown is enforced before another email is sent", async (t) => {
  const latest = { requestedAt: new Date() };
  const send = t.mock.method(emailService, "sendEmail", async () => {});
  t.mock.method(emailService, "canSendEmail", () => true);
  const findOne = t.mock.method(OtpRequest, "findOne", () => ({ sort: async () => latest }));
  const count = t.mock.method(OtpRequest, "countDocuments", async () => 0);

  await assert.rejects(
    createEmailVerification({
      accountId: "account-a",
      challengeId: "cooldown-challenge",
      email: "person@example.com",
      action: "login_verification",
    }),
    (error) => error.status === 429 && error.retryAfterSeconds > 0,
  );
  assert.deepEqual(findOne.mock.calls[0].arguments[0], {
    accountId: "account-a",
    action: "login_verification",
    channel: "email",
    email: "person@example.com",
  });
  assert.equal(count.mock.callCount(), 0);
  assert.equal(send.mock.callCount(), 0);
});
