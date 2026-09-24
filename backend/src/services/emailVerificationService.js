const crypto = require("crypto");
const OtpRequest = require("../models/OtpRequest");
const env = require("../config/env");
const emailService = require("../utils/email");
const { buildOtpEmail } = require("../utils/otpEmailTemplate");

const OTP_TTL_MINUTES = Math.max(3, Math.min(15, Number(env.otpTtlMinutes || 5)));
const OTP_RESEND_COOLDOWN_SECONDS = Math.max(30, Math.min(300, Number(env.otpResendCooldownSeconds || 60)));
const OTP_REQUEST_WINDOW_MINUTES = Math.max(5, Math.min(60, Number(env.otpRequestWindowMinutes || 15)));
const OTP_MAX_REQUESTS_PER_WINDOW = Math.max(2, Math.min(10, Number(env.otpMaxRequestsPerWindow || 5)));
const OTP_MAX_ATTEMPTS = Math.max(3, Math.min(10, Number(env.otpMaxAttempts || 5)));
const OTP_ACTION_CHANNELS = Object.freeze({
  register_email: ["email"],
  password_reset: ["email"],
  login_verification: ["email"],
});

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();
const isValidEmail = (email = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
const generateEmailCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
const hashVerificationCode = ({ accountId = "", challengeId = "", email = "", action = "", code = "" }) =>
  crypto
    .createHmac("sha256", env.jwtSecret)
    .update(`${String(accountId).trim()}\n${String(challengeId).trim()}\n${normalizeEmail(email)}\n${String(action).trim()}\n${String(code)}`)
    .digest("hex");
const hashesMatch = (storedHash = "", submittedHash = "") => {
  const stored = Buffer.from(String(storedHash), "hex");
  const submitted = Buffer.from(String(submittedHash), "hex");
  return stored.length > 0 && stored.length === submitted.length && crypto.timingSafeEqual(stored, submitted);
};

const validateRequest = ({ accountId = "", challengeId = "", email = "", action, channel }) => {
  if (!OTP_ACTION_CHANNELS[action]?.includes(channel) || !isValidEmail(email)) {
    const error = new Error("A supported email verification request is required.");
    error.status = 400;
    throw error;
  }
  if (["login_verification", "password_reset"].includes(action) && !String(accountId || "").trim()) {
    const error = new Error("An account-bound verification request is required.");
    error.status = 400;
    throw error;
  }
  if (action === "login_verification" && !String(challengeId || "").trim()) {
    const error = new Error("A login challenge-bound verification request is required.");
    error.status = 400;
    throw error;
  }
};

const createEmailVerification = async ({ accountId = "", challengeId = "", email = "", action, metadata = {} }) => {
  const channel = "email";
  validateRequest({ accountId, challengeId, email, action, channel });
  if (!emailService.canSendEmail()) {
    const error = new Error("Email verification is temporarily unavailable.");
    error.status = 503;
    throw error;
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedChallengeId = String(challengeId || "").trim();
  const rateLimitQuery = {
    action,
    channel,
    email: normalizedEmail,
    ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
  };
  const now = new Date();
  const latest = await OtpRequest.findOne(rateLimitQuery).sort({ requestedAt: -1 });
  if (latest?.requestedAt) {
    const retryAfterSeconds = Math.ceil(
      (latest.requestedAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000,
    );
    if (retryAfterSeconds > 0) {
      const error = new Error(`Please wait ${retryAfterSeconds}s before requesting another code.`);
      error.status = 429;
      error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    }
  }

  const windowStart = new Date(now.getTime() - OTP_REQUEST_WINDOW_MINUTES * 60 * 1000);
  const requestCount = await OtpRequest.countDocuments({ ...rateLimitQuery, requestedAt: { $gte: windowStart } });
  if (requestCount >= OTP_MAX_REQUESTS_PER_WINDOW) {
    const error = new Error("Too many verification requests. Please try again later.");
    error.status = 429;
    error.retryAfterSeconds = OTP_REQUEST_WINDOW_MINUTES * 60;
    throw error;
  }

  const code = generateEmailCode();
  const otpRequest = await OtpRequest.create({
    accountId: normalizedAccountId,
    challengeId: normalizedChallengeId,
    email: normalizedEmail,
    action,
    channel,
    codeHash: hashVerificationCode({
      accountId: normalizedAccountId,
      challengeId: normalizedChallengeId,
      email: normalizedEmail,
      action,
      code,
    }),
    requestedAt: now,
    expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000),
    metadata,
  });

  try {
    const message = buildOtpEmail({ code, action, expiresInMinutes: OTP_TTL_MINUTES });
    await emailService.sendEmail({ to: normalizedEmail, ...message });
  } catch (error) {
    await OtpRequest.deleteOne({ _id: otpRequest._id });
    throw error;
  }
  return { otpRequest };
};

const verifyEmailCode = async ({ accountId = "", challengeId = "", email = "", action, code }) => {
  const channel = "email";
  validateRequest({ accountId, challengeId, email, action, channel });
  const query = {
    accountId: String(accountId || "").trim(),
    challengeId: String(challengeId || "").trim(),
    email: normalizeEmail(email),
    action,
    channel,
    verifiedAt: null,
  };
  if (!query.accountId) delete query.accountId;
  if (!query.challengeId) delete query.challengeId;
  const otp = await OtpRequest.findOne(query).sort({ createdAt: -1 });
  if (!otp) return { ok: false, reason: "not_found" };
  if (!otp.expiresAt || otp.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (otp.lockedAt || Number(otp.attempts || 0) >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked" };
  const submittedHash = hashVerificationCode({
    accountId: query.accountId || "",
    challengeId: query.challengeId || "",
    email: query.email,
    action,
    code,
  });
  if (!hashesMatch(otp.codeHash, submittedHash)) {
    const lastAttemptAt = new Date();
    const attempted = await OtpRequest.findOneAndUpdate(
      {
        _id: otp._id,
        verifiedAt: null,
        lockedAt: null,
        attempts: { $lt: OTP_MAX_ATTEMPTS },
        expiresAt: { $gte: lastAttemptAt },
      },
      { $inc: { attempts: 1 }, $set: { lastAttemptAt } },
      { new: true },
    );
    if (attempted && Number(attempted.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      attempted.lockedAt = lastAttemptAt;
      await attempted.save();
    }
    return {
      ok: false,
      reason: !attempted || Number(attempted.attempts || 0) >= OTP_MAX_ATTEMPTS ? "locked" : "invalid",
    };
  }
  const verifiedAt = new Date();
  const consumed = await OtpRequest.findOneAndUpdate(
    {
      _id: otp._id,
      codeHash: submittedHash,
      verifiedAt: null,
      lockedAt: null,
      attempts: { $lt: OTP_MAX_ATTEMPTS },
      expiresAt: { $gte: verifiedAt },
    },
    { $set: { verifiedAt } },
    { new: true },
  );
  if (!consumed) return { ok: false, reason: "not_found" };
  return { ok: true, otpRequest: consumed };
};

module.exports = {
  OTP_ACTION_CHANNELS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  createEmailVerification,
  hashVerificationCode,
  isValidEmail,
  normalizeEmail,
  verifyEmailCode,
};
