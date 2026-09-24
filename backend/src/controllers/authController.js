const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const zxcvbn = require("zxcvbn");
const User = require("../models/User");
const OtpRequest = require("../models/OtpRequest"); // Symmetrical V3 Model
const AuditLog = require("../models/AuditLog");
const { signUserAccessToken } = require("../utils/token");
const env = require("../config/env");
const { requiresTotpEnrollment } = require("../domain/accountSecurityPolicy");
const { BRANCHES } = require("../domain/branchRouting");
const { canSendEmail, sendEmail } = require("../utils/email");
const { buildOtpEmail } = require("../utils/otpEmailTemplate");
const { resolveConfiguredBranch } = require("../services/branchCoverageService");
const {
  duplicateIdentityMessage,
} = require("../utils/optionalIdentity");
const {
  decryptSecret,
  generateOtpCode,
  verifyTotpCode,
} = require("../domain/accountSecurity");
const {
  mergeClientRegistrationProgress,
} = require("../domain/registrationProgress");
const { hashPasswordResetToken, isAuthenticPasswordResetToken } = require("../domain/passwordResetLink");
const {
  SHARED_DEMO_EMAIL,
  canUseSharedDemoEmail,
} = require("../domain/demoStaffPolicy");

const OTP_TTL_MINUTES = Math.max(
  3,
  Math.min(15, Number(env.otpTtlMinutes || 5)),
);
const OTP_RESEND_COOLDOWN_SECONDS = Math.max(30, Math.min(300, Number(env.otpResendCooldownSeconds || 60)));
const OTP_REQUEST_WINDOW_MINUTES = Math.max(5, Math.min(60, Number(env.otpRequestWindowMinutes || 15)));
const OTP_MAX_REQUESTS_PER_WINDOW = Math.max(2, Math.min(10, Number(env.otpMaxRequestsPerWindow || 5)));
const OTP_MAX_ATTEMPTS = Math.max(3, Math.min(10, Number(env.otpMaxAttempts || 5)));
const OTP_ACTION_CHANNELS = {
  register_email: ["email"],
  password_reset: ["email"],
};
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();
const isValidEmail = (email = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
const isReservedSharedDemoEmail = (email = "") => normalizeEmail(email) === SHARED_DEMO_EMAIL;
const normalizeIdentifier = (value = "") => String(value).trim().toLowerCase();
const { canonicalizePhMobile, isValidPhMobile } = require("../utils/phMobile");
const isValidSixDigitCode = (value = "") =>
  /^\d{6}$/.test(String(value).trim());
const signRegistrationVerificationToken = ({ email = "", phone = "" }) =>
  jwt.sign(
    {
      purpose: "registration_verification",
      email: normalizeEmail(email),
      phone: canonicalizePhMobile(phone),
    },
    env.jwtSecret,
    { expiresIn: `${OTP_TTL_MINUTES}m` },
  );

const findAccountByIdentifier = async (identifier = "") => {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!normalizedIdentifier) return { user: null, ambiguous: false };
  const normalizedPhone = canonicalizePhMobile(identifier);
  const uniqueConditions = [
    { alias: normalizedIdentifier },
    { username: normalizedIdentifier },
  ];
  if (isValidPhMobile(normalizedPhone)) uniqueConditions.push({ phone: normalizedPhone });
  const uniqueUser = await User.findOne({ $or: uniqueConditions });
  if (uniqueUser) return { user: uniqueUser, ambiguous: false };
  if (!isValidEmail(normalizedIdentifier)) return { user: null, ambiguous: false };
  const emailUsers = await User.find({ email: normalizedIdentifier }).limit(2);
  return {
    user: emailUsers.length === 1 ? emailUsers[0] : null,
    ambiguous: emailUsers.length > 1,
  };
};

const resolvePasswordRecoveryAccount = async ({ identifier = "", accountLoginId = "" } = {}) => {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (normalizedIdentifier !== SHARED_DEMO_EMAIL) {
    return findAccountByIdentifier(normalizedIdentifier);
  }

  const normalizedAccountLoginId = normalizeIdentifier(accountLoginId);
  if (!normalizedAccountLoginId || normalizedAccountLoginId === SHARED_DEMO_EMAIL) {
    return { user: null, ambiguous: true, requiresAccountLoginId: true };
  }

  const user = await User.findOne({
    $or: [
      { alias: normalizedAccountLoginId },
      { username: normalizedAccountLoginId },
    ],
  });
  if (
    !user ||
    normalizeEmail(user.email) !== SHARED_DEMO_EMAIL ||
    !canUseSharedDemoEmail(user, SHARED_DEMO_EMAIL)
  ) {
    return { user: null, ambiguous: false, invalidAccountLoginId: true };
  }
  return { user, ambiguous: false };
};

const hashValue = (value = "") =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const isOtpExpired = (otp) =>
  !otp || !otp.expiresAt || otp.expiresAt.getTime() < Date.now();

const sendOtpMessage = async ({ recipient, channel, action, code }) => {
  if (channel === "email") {
    if (!canSendEmail()) {
      throw new Error("Email verification is temporarily unavailable.");
    }
    const email = buildOtpEmail({
      code,
      action,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
    await sendEmail({ to: recipient, ...email });
    return;
  }

  throw new Error("Only email OTP delivery is supported.");
};

/**
 * SYMMETRICAL OTP HELPERS
 */
const createOtpRequest = async ({
  accountId = "",
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
  metadata = {},
}) => {
  if (!OTP_ACTION_CHANNELS[action]?.includes(channel) || !isValidEmail(email)) {
    const error = new Error("A supported email verification request is required.");
    error.status = 400;
    throw error;
  }
  const normalizedEmail = normalizeEmail(email);
  const normalizedAccountId = String(accountId || "").trim();
  const targetQuery = {
    action,
    channel,
    email: normalizedEmail,
    ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
  };
  const now = new Date();
  const latest = await OtpRequest.findOne(targetQuery).sort({ requestedAt: -1 });
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
  const requestCount = await OtpRequest.countDocuments({ ...targetQuery, requestedAt: { $gte: windowStart } });
  if (requestCount >= OTP_MAX_REQUESTS_PER_WINDOW) {
    const error = new Error("Too many verification requests. Please try again later.");
    error.status = 429;
    error.retryAfterSeconds = OTP_REQUEST_WINDOW_MINUTES * 60;
    throw error;
  }
  const code = generateOtpCode();
  const codeHash = hashValue(code);
  const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

  const otpRequest = await OtpRequest.create({
    accountId: normalizedAccountId,
    email: normalizedEmail,
    phone: "",
    messenger_handle: "",
    action,
    channel,
    codeHash,
    requestedAt: now,
    expiresAt,
    metadata,
  });

  try {
    await sendOtpMessage({
      recipient: normalizedEmail,
      channel,
      action,
      code,
    });
  } catch (error) {
    await OtpRequest.deleteOne({ _id: otpRequest._id });
    throw error;
  }

  return { otpRequest };
};

const findOtpRequest = async ({
  accountId = "",
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
}) => {
  if (!OTP_ACTION_CHANNELS[action]?.includes(channel) || !isValidEmail(email)) return null;
  const normalizedAccountId = String(accountId || "").trim();
  const query = {
    action,
    channel,
    verifiedAt: null,
    email: normalizeEmail(email),
    ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
  };
  return OtpRequest.findOne(query).sort({ createdAt: -1 });
};

const verifyOtpRequest = async ({
  accountId = "",
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
  code,
}) => {
  const otp = await findOtpRequest({
    accountId,
    email,
    phone,
    messenger_handle,
    action,
    channel,
  });
  if (!otp) return { ok: false, reason: "not_found" };
  if (isOtpExpired(otp)) return { ok: false, reason: "expired" };
  if (otp.lockedAt || Number(otp.attempts || 0) >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  if (otp.codeHash !== hashValue(code)) {
    otp.attempts = Number(otp.attempts || 0) + 1;
    otp.lastAttemptAt = new Date();
    if (otp.attempts >= OTP_MAX_ATTEMPTS) otp.lockedAt = new Date();
    await otp.save();
    return { ok: false, reason: otp.lockedAt ? "locked" : "invalid" };
  }

  otp.verifiedAt = new Date();
  await otp.save();
  return { ok: true };
};

/**
 * PRIMARY CONTROLLERS
 */
const requestOtp = async (req, res) => {
  const { action, channel, email, phone, messenger_handle } = req.body;

  if (!action || !channel) {
    return res
      .status(400)
      .json({ message: "Action and channel are required." });
  }
  if (channel !== "email") {
    return res.status(400).json({ message: "Use email verification." });
  }
  if (!OTP_ACTION_CHANNELS[action]?.includes(channel)) {
    return res.status(400).json({ message: "This verification request is not supported." });
  }
  if (channel === "email" && !isValidEmail(email)) {
    return res.status(400).json({ message: "A valid email address is required for email verification." });
  }
  if (action === "register_email" && isReservedSharedDemoEmail(email)) {
    return res.status(409).json({ message: "This email address is reserved for approved demo staff accounts." });
  }

  // 1. Validation for specific actions
  if (action === "register_email" && !email) {
    return res.status(400).json({ message: "Email required." });
  }
  // 2. Uniqueness checks
  if (
    action === "register_email" &&
    (await User.findOne({ email: normalizeEmail(email) }))
  ) {
    return res.status(409).json({ message: "Email already exists." });
  }

  try {
    const { otpRequest } = await createOtpRequest({
      email,
      phone,
      messenger_handle,
      action,
      channel,
    });

    return res.json({
      message: "Code sent successfully.",
      expiresAt: otpRequest.expiresAt,
      resendAvailableAt: new Date(otpRequest.requestedAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000),
    });
  } catch (err) {
    console.error("[OTP] Request failed:", err?.message || err);
    const isRateLimit = Number(err.status) === 429;
    return res.status(isRateLimit ? 429 : 503).json({
      message: isRateLimit
        ? err.message
        : "Email verification could not be sent right now. Please try again later.",
      retryAfterSeconds: err.retryAfterSeconds || undefined,
    });
  }
};

const verifyOtp = async (req, res) => {
  const { action, channel, email, phone, messenger_handle, code } = req.body;

  if (!OTP_ACTION_CHANNELS[action]?.includes(channel) || !isValidEmail(email)) {
    return res.status(400).json({ message: "A supported email verification request is required." });
  }
  if (action === "register_email" && isReservedSharedDemoEmail(email)) {
    return res.status(409).json({ message: "This email address is reserved for approved demo staff accounts." });
  }

  if (!action || !code) {
    return res.status(400).json({ message: "Action and code required." });
  }

  try {
    const verification = await verifyOtpRequest({
      email,
      phone,
      messenger_handle,
      action,
      channel,
      code,
    });

    if (!verification.ok) {
      return res.status(400).json({
        message: verification.reason === "locked"
          ? "Too many incorrect codes. Request a new verification code."
          : "Invalid or expired code.",
      });
    }

    // Keep registration verification progress resumable for both web and mobile.
    if (action.startsWith("register_")) {
      const existing = req.session.registrationProgress || {};
      const data = existing.formData || {};
      if (action === "register_email") {
        data.email = normalizeEmail(email);
        data.emailVerified = true;
      }
      data.verificationChannel = "email";
      data.phoneVerified = false;
      req.session.registrationProgress = {
        ...existing,
        email: normalizeEmail(email || existing.email || data.email),
        stepIndex: Math.max(1, Number(existing.stepIndex) || 0),
        formData: data,
      };
    }

    const registrationVerificationToken = action.startsWith("register_")
      ? signRegistrationVerificationToken({
        email: action === "register_email" ? email : "",
        phone: "",
      })
      : "";

    return req.session.save((error) => {
      if (error) return res.status(500).json({ message: "Unable to save verification progress." });
      return res.json({
        message: "Verification successful.",
        registrationProgress: req.session.registrationProgress || null,
        registrationVerificationToken: registrationVerificationToken || undefined,
      });
    });
  } catch (err) {
    console.error("[OTP] Verify Error:", err);
    return res.status(500).json({ message: "Error verifying OTP." });
  }
};

const checkAliasAvailability = async (req, res) => {
  const alias = String(req.query.alias || "")
    .trim()
    .toLowerCase();
  if (!alias) {
    return res.status(400).json({ message: "Alias is required." });
  }

  try {
    const existing = await User.findOne({
      $or: [{ alias }, { username: alias }],
    });
    return res.json({ available: !existing });
  } catch (err) {
    return res.status(500).json({ message: "Error checking alias." });
  }
};

const startRegistration = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res
      .status(400)
      .json({ errors: { email: "Valid email is required" } });
  }
  if (isReservedSharedDemoEmail(email)) {
    return res.status(409).json({ errors: { email: "This email address is reserved for approved demo staff accounts" } });
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).json({ errors: { email: "Email already exists" } });
  }

  try {
    const { otpRequest } = await createOtpRequest({
      email,
      action: "register_email",
      channel: "email",
    });
    return res.json({
      email,
      message: "Verification code sent.",
      expiresAt: otpRequest.expiresAt,
      resendAvailableAt: new Date(otpRequest.requestedAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000),
    });
  } catch (error) {
    return res.status(error.status || 502).json({ message: error.message || "Unable to send verification code." });
  }
};

const verifyRegistrationCode = async (req, res) => {
  const { email, code } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !isValidSixDigitCode(code)) {
    return res.status(400).json({ message: "Data required." });
  }
  if (isReservedSharedDemoEmail(normalizedEmail)) {
    return res.status(409).json({ message: "This email address is reserved for approved demo staff accounts." });
  }
  const verification = await verifyOtpRequest({ email: normalizedEmail, action: "register_email", channel: "email", code });
  if (!verification.ok) return res.status(400).json({ message: "Invalid or expired code." });

  req.session.registrationProgress = {
    email: normalizedEmail,
    stepIndex: 1,
    formData: {
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      emailVerified: true,
    },
  };

  return req.session.save((error) => {
    if (error) return res.status(500).json({ message: "Unable to save email verification." });
    return res.json({
      message: "Success",
      registrationProgress: req.session.registrationProgress,
      registrationVerificationToken: signRegistrationVerificationToken({ email: normalizedEmail }),
    });
  });
};

const { validateRegistrationConsent, registrationConsentRecord } = require("../domain/registrationConsent");
const register = async (req, res) => {
  const {
    name_first,
    name_last,
    alias,
    email,
    phone,
    password,
    address,
    municipality,
    municipality_code,
    submunicipality,
    submunicipality_code,
    thoroughfare,
    property_block_lot,
    apartment_unit,
    landmark,
    plus_code,
    contact_method,
    messenger_handle,
    delivery_instructions,
    locations = [],
    registrationVerificationToken,
  } = req.body;
  try {
    if (typeof password !== "string" || password.length < 8 || password.length > 25) {
      return res.status(400).json({ message: "Password must be between 8 and 25 characters." });
    }
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ message: "A valid email address is required." });
    }
    if (isReservedSharedDemoEmail(normalizedEmail)) {
      return res.status(409).json({ message: "This email address is reserved for approved demo staff accounts." });
    }
    const normalizedPhone = canonicalizePhMobile(phone);
    if (normalizedPhone && !isValidPhMobile(normalizedPhone)) {
      return res.status(400).json({ message: "Enter a Philippine mobile number such as 09123456789 or +639123456789, or leave the optional phone field empty." });
    }
    const registrationProgress = req.session?.registrationProgress?.formData || {};
    const emailVerified = Boolean(
      registrationProgress.emailVerified
      && normalizeEmail(registrationProgress.email) === normalizedEmail,
    );

    let tokenVerified = false;
    if (registrationVerificationToken) {
      try {
        const decoded = jwt.verify(registrationVerificationToken, env.jwtSecret);
        tokenVerified = decoded?.purpose === "registration_verification"
          && Boolean(decoded.email && normalizeEmail(decoded.email) === normalizedEmail);
      } catch (_error) {
        tokenVerified = false;
      }
    }

    if (!emailVerified && !tokenVerified) {
      return res.status(403).json({
        message: "Verify your email before creating an account.",
      });
    }

    const consentError = validateRegistrationConsent(req.body.legalConsent);
    if (consentError) return res.status(400).json({ message: consentError });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Auto-generate alias from email if not provided (Technical Fallback)
    const finalAlias = (
      alias
      || normalizedEmail.split("@")[0]
    )
      .toLowerCase()
      .trim();

    const primaryLoc = locations[0] || null;
    let assignedBranch = "";
    if (primaryLoc?.address) {
      try {
        assignedBranch = (await resolveConfiguredBranch(primaryLoc.address))?.name || "";
      } catch (error) {
        // Coverage can be retried later from the saved address. A temporary
        // branch lookup issue must not prevent a verified customer signup.
        console.error("Unable to assign registration branch:", error.message);
      }
    }
    const addressString = primaryLoc
      ? `${primaryLoc.address.street}, ${primaryLoc.address.city}, ${primaryLoc.address.province}`.trim()
      : "";

    const newUser = await User.create({
      legalConsent: registrationConsentRecord(req.body.legalConsent),
      name: `${name_first} ${name_last}`,
      name_first,
      name_last,
      alias: finalAlias,
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      passwordHash,
      messenger_handle,
      // Public registration must never be allowed to provision a privileged
      // account or choose its own branch. Staff are created by Super Admin.
      role: "customer",
      assignedBranch,
      activeBranch: assignedBranch,
      address: addressString,
      municipality: municipality || primaryLoc?.address?.city || "",
      municipality_code: municipality_code || "",
      submunicipality: submunicipality || primaryLoc?.address?.barangay || "",
      submunicipality_code: submunicipality_code || "",
      thoroughfare: thoroughfare || "",
      property_block_lot: property_block_lot || "",
      apartment_unit: apartment_unit || "",
      landmark: landmark || "",
      plus_code: plus_code || "",
      contact_method: "email",
      billingAddress: primaryLoc ? primaryLoc.address : {},
      location: primaryLoc || { address: {}, coordinates: {} },
      delivery_instructions: delivery_instructions || "",
      addresses: locations.map((loc, idx) => ({
        ...loc.address,
        label: `Location ${idx + 1}`,
        type: "home",
        name: `${name_first} ${name_last}`.trim(),
        phone: normalizedPhone,
        isDefault: idx === 0,
      })),
      accountStatus: "active",
    });

    // Final database purge for this email after successful registration
    await OtpRequest.deleteMany({
      $or: [
        { email: normalizedEmail },
        ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
      ],
    });
    if (req.session) req.session.destroy();

    const token = signUserAccessToken(newUser);
    return res.json({ success: true, token, user: newUser.toJSON() });
  } catch (err) {
    const conflictMessage = duplicateIdentityMessage(err);
    if (conflictMessage) {
      return res.status(409).json({ message: conflictMessage });
    }
    console.error("Registration failed:", err.message);
    return res.status(500).json({
      message: "Unable to create your account right now. Please try again.",
    });
  }
};

const login = async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const account = await findAccountByIdentifier(identifier);
    if (account.ambiguous) {
      return res.status(409).json({
        message: "This demo email belongs to multiple accounts. Sign in with the account's unique login ID.",
      });
    }
    const user = account.user;

    if (user?.lockoutUntil && user.lockoutUntil > new Date()) {
      return res.status(429).json({ message: "Too many failed attempts. Try again later." });
    }
    if (
      user &&
      (user.isDeleted || ["disabled", "deleted"].includes(String(user.accountStatus || "")))
    ) {
      return res.status(403).json({ message: "This account is not active." });
    }
    if (!user || !(await bcrypt.compare(String(password || ""), user.passwordHash))) {
      if (user) {
        user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= LOGIN_MAX_ATTEMPTS) {
          user.lockoutUntil = new Date(Date.now() + LOGIN_LOCKOUT_MS);
          user.failedLoginAttempts = 0;
        }
        await user.save();
      }
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (user.security?.totpEnabled) {
      const challengeToken = jwt.sign(
        { purpose: "login_totp", sub: user.id },
        env.jwtSecret,
        { expiresIn: "5m" },
      );
      return res.json({
        success: true,
        requiresTotp: true,
        challengeToken,
        message: "Enter the six-digit code from your authenticator app.",
      });
    }
    user.failedLoginAttempts = 0;
    user.lockoutUntil = null;
    user.lastLogin = new Date();
    await user.save();
    const token = signUserAccessToken(user, user.security?.totpResetRequired ? { recovery: true } : {});
    return res.json({
      success: true,
      token,
      user: user.toJSON(),
      requiresTotpSetup: requiresTotpEnrollment(user),
    });
  } catch (err) {
    return res.status(500).json({ message: "Login error" });
  }
};

const verifyLoginTotp = async (req, res) => {
  try {
    const challengeToken = String(req.body?.challengeToken || "");
    const code = String(req.body?.code || "").trim();
    let payload;
    try {
      payload = jwt.verify(challengeToken, env.jwtSecret);
    } catch (_error) {
      return res.status(401).json({ message: "The sign-in verification has expired. Sign in again." });
    }
    if (payload?.purpose !== "login_totp" || !payload?.sub) {
      return res.status(401).json({ message: "Invalid sign-in verification." });
    }
    const user = await User.findById(payload.sub).select("+security.totpSecretEncrypted");
    if (!user || !user.security?.totpEnabled) {
      return res.status(401).json({ message: "Authenticator verification is not available for this account." });
    }
    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
      return res.status(429).json({ message: "Too many failed attempts. Try again later." });
    }
    let secret = "";
    try {
      secret = decryptSecret(user.security.totpSecretEncrypted);
    } catch (_error) {
      return res.status(500).json({ message: "Authenticator verification is temporarily unavailable." });
    }
    if (!secret) {
      // A missing stored key is an account configuration problem, not a wrong
      // code. Keep access blocked without counting this against the user.
      return res.status(409).json({ message: "Your account's authenticator setup needs recovery. Contact support to restore access; requesting another password reset will not repair it." });
    }
    if (!verifyTotpCode({ secret, code })) {
      user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= LOGIN_MAX_ATTEMPTS) {
        user.lockoutUntil = new Date(Date.now() + LOGIN_LOCKOUT_MS);
        user.failedLoginAttempts = 0;
      }
      await user.save();
      return res.status(401).json({ message: "Incorrect authenticator code." });
    }
    user.failedLoginAttempts = 0;
    user.lockoutUntil = null;
    user.lastLogin = new Date();
    await user.save();
    const token = signUserAccessToken(user);
    return res.json({ success: true, token, user: user.toJSON() });
  } catch (error) {
    console.error("TOTP login verification failed:", error.message);
    return res.status(500).json({ message: "Unable to verify the authenticator code." });
  }
};

const logout = async (req, res) => {
  console.info("[AUTH] Clearing the current registration session.");
  try {
    const email =
      req.session?.registrationProgress?.email ||
      req.session?.tempRegistrationEmail;
    if (email) {
      const deleted = await OtpRequest.deleteMany({
        email: normalizeEmail(email),
      });
      console.info(`[AUTH] Cleared ${deleted.deletedCount} temporary OTP request(s).`);
    }
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie("aeropulse.sid");
        return res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ message: "Reset failed." });
  }
};

const getSession = async (req, res) => {
  return res.json({
    session: {
      registrationProgress: req.session?.registrationProgress || null,
      cart: req.session?.cart || [],
    },
  });
};

const updateRegistrationProgress = async (req, res) => {
  const incoming = req.body?.progress;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ message: "Registration progress is required." });
  }

  req.session.registrationProgress = mergeClientRegistrationProgress({
    existing: req.session.registrationProgress || {},
    incoming,
  });
  return req.session.save((error) => {
    if (error) return res.status(500).json({ message: "Unable to save registration progress." });
    return res.json({ success: true, registrationProgress: req.session.registrationProgress });
  });
};

const updateCart = async (req, res) => {
  req.session.cart = req.body.cart;
  return res.json({ success: true });
};

const me = async (req, res) => {
  const user =
    req.authUser ||
    (req.user?.sub ? await User.findById(req.user.sub) : null);
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json({ user: user.toJSON ? user.toJSON() : user });
};

const requestPasswordReset = async (req, res) => {
  if (req.body.channel && req.body.channel !== "email") {
    return res.status(400).json({ message: "Use email verification." });
  }
  const channel = "email";
  const identifier = normalizeIdentifier(req.body.identifier || req.body.email || "");
  if (!identifier) return res.status(400).json({ message: "Enter your email address or unique account login ID." });
  const accountLoginId = normalizeIdentifier(req.body.accountLoginId || "");
  const account = await resolvePasswordRecoveryAccount({ identifier, accountLoginId });
  if (account.requiresAccountLoginId || account.ambiguous) {
    return res.status(409).json({ message: "This demo email belongs to multiple accounts. Enter the account's unique login ID to choose the account to recover." });
  }
  if (account.invalidAccountLoginId) {
    return res.status(400).json({ message: "The shared demo email and account login ID do not match an approved demo account." });
  }
  const user = account.user;
  if (!user) return res.json({ message: "If the account exists, a verification code has been sent." });
  const email = normalizeEmail(user.email);
  if (!isValidEmail(email)) return res.status(409).json({ message: "This account does not have a valid recovery email. Contact your administrator." });

  try {
    const { otpRequest } = await createOtpRequest({
      accountId: user.id,
      email,
      action: "password_reset",
      channel,
    });
    return res.json({
      message: "If the account exists, a verification code has been sent.",
      expiresAt: otpRequest.expiresAt,
      resendAvailableAt: new Date(otpRequest.requestedAt.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000),
    });
  } catch (error) {
    return res.status(error.status || 502).json({
      message: error.message || "Unable to send verification code.",
      retryAfterSeconds: error.retryAfterSeconds || undefined,
    });
  }
};

const resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  try {
    if (typeof password !== "string" || password.length < 8 || password.length > 25) {
      return res.status(400).json({ message: "Password must be between 8 and 25 characters." });
    }
    let user = null;
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      if (decoded.purpose !== "password_reset") throw new Error("Not a password-reset token");
      user = await User.findById(decoded.sub);
    } catch {
      // Account Settings sends a one-time, database-backed link rather than a
      // login JWT. Validate its signature, hash, expiry and single-use state.
      if (!isAuthenticPasswordResetToken(token)) {
        return res.status(400).json({ message: "This reset link is invalid, expired, or has already been used. Request a new link and try again." });
      }
      user = await User.findOne({
        "passwordReset.tokenHash": hashPasswordResetToken(token),
        "passwordReset.expiresAt": { $gt: new Date() },
        "passwordReset.usedAt": null,
      });
    }
    if (!user) return res.status(400).json({ message: "This reset link is invalid, expired, or has already been used. Request a new link and try again." });
    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);
    user.passwordReset = { tokenHash: "", expiresAt: null, usedAt: new Date(), requestedAt: user.passwordReset?.requestedAt || new Date() };
    // Hidden authenticator/recovery fields are not selected by this query.
    // Replacing the parent security object would erase them in the database.
    user.security.sessionVersion = Number(user.security?.sessionVersion || 0) + 1;
    await user.save();
    res.json({ message: "Success" });
  } catch (err) {
    res.status(400).json({ message: "This reset link is invalid, expired, or has already been used. Request a new link and try again." });
  }
};

const resetPasswordWithCode = async (req, res) => {
  const { email: requestedEmail, identifier, code, newPassword } = req.body;
  if (req.body.channel && req.body.channel !== "email") {
    return res.status(400).json({ message: "Use email verification." });
  }
  const channel = "email";
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 25) {
    return res.status(400).json({ message: "Password must be between 8 and 25 characters." });
  }
  const accountIdentifier = normalizeIdentifier(identifier || requestedEmail);
  if (!accountIdentifier) return res.status(400).json({ message: "Enter your email address or unique account login ID." });
  const accountLoginId = normalizeIdentifier(req.body.accountLoginId || "");
  const account = await resolvePasswordRecoveryAccount({ identifier: accountIdentifier, accountLoginId });
  if (account.requiresAccountLoginId || account.ambiguous) {
    return res.status(409).json({ message: "This demo email belongs to multiple accounts. Enter the account's unique login ID to choose the account to recover." });
  }
  if (account.invalidAccountLoginId) {
    return res.status(400).json({ message: "The shared demo email and account login ID do not match an approved demo account." });
  }
  const user = account.user;
  if (!user) return res.status(404).json({ message: "User not found." });
  const normalizedEmail = normalizeEmail(user.email);
  if (!isValidEmail(normalizedEmail)) return res.status(409).json({ message: "This account does not have a valid recovery email. Contact your administrator." });
  const verification = await verifyOtpRequest({
    accountId: user.id,
    email: normalizedEmail,
    action: "password_reset",
    channel,
    code,
  });
  if (!verification.ok)
    return res.status(400).json({ message: "Invalid code." });
  const salt = await bcrypt.genSalt(10);
  user.passwordHash = await bcrypt.hash(newPassword, salt);
  // Preserve the unselected authenticator secret and recovery-code hashes.
  user.security.sessionVersion = Number(user.security?.sessionVersion || 0) + 1;
  await user.save();
  res.json({ message: "Success" });
};

module.exports = {
  startRegistration,
  verifyRegistrationCode,
  register,
  login,
  verifyLoginTotp,
  logout,
  me,
  requestPasswordReset,
  resetPassword,
  requestOtp,
  verifyOtp,
  checkAliasAvailability,
  resetPasswordWithCode,
  getSession,
  updateRegistrationProgress,
  updateCart,
};
