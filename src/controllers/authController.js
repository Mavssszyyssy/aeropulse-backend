const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const zxcvbn = require("zxcvbn");
const User = require("../models/User");
const OtpRequest = require("../models/OtpRequest"); // Symmetrical V3 Model
const AuditLog = require("../models/AuditLog");
const { signAccessToken } = require("../utils/token");
const env = require("../config/env");
const { BRANCHES } = require("../domain/branchRouting");
const { canSendEmail, sendEmail } = require("../utils/email");

const OTP_TTL_MINUTES = Math.max(
  3,
  Math.min(15, Number(env.otpTtlMinutes || 5)),
);

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();
const normalizeIdentifier = (value = "") => String(value).trim().toLowerCase();
const normalizePhone = (phone = "") => String(phone).replace(/\D/g, "");
const canonicalizePhMobile = (phone = "") => {
  const digits = normalizePhone(phone);
  if (/^639\d{9}$/.test(digits)) return `09${digits.slice(3)}`;
  return digits;
};
const isValidSixDigitCode = (value = "") =>
  /^\d{6}$/.test(String(value).trim());

const toInternationalFormat = (phone = "") => {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("09") && digits.length === 11) {
    return `639${digits.slice(2)}`;
  }
  return digits;
};

const infobipBaseUrl = () =>
  String(env.infobipBaseUrl || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

const sendSmsViaInfobip = async ({ recipient, message }) => {
  const baseUrl = infobipBaseUrl();
  const sender = String(env.infobipSender || "").trim();
  const destination = toInternationalFormat(recipient);

  if (!env.infobipApiKey || !baseUrl || !sender) {
    throw new Error("SMS delivery is not configured. Add the Infobip API key, base URL, and sender.");
  }
  if (!/^\d{8,15}$/.test(destination)) {
    throw new Error("Enter a valid mobile number, including the country code.");
  }

  let response;
  try {
    response = await fetch(`https://${baseUrl}/sms/3/messages`, {
      method: "POST",
      headers: {
        Authorization: `App ${env.infobipApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            sender,
            destinations: [{ to: destination }],
            content: { text: message },
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`SMS provider could not be reached: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.requestError?.serviceException?.text || data?.message || "Infobip rejected the SMS request.";
    console.error("[INFOBIP] SMS dispatch failed", {
      status: response.status,
      detail,
      destination,
    });
    throw new Error(`SMS could not be sent: ${detail}`);
  }

  const accepted = data?.messages?.[0] || {};
  console.log("[INFOBIP] SMS accepted", {
    messageId: accepted.messageId || "",
    to: destination,
    status: accepted.status?.name || "PENDING",
  });
  return accepted;
};

const generateOtpCode = () =>
  String(Math.floor(100000 + Math.random() * 900000)).padStart(6, "0");
const hashValue = (value = "") =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const isOtpExpired = (otp) =>
  !otp || !otp.expiresAt || otp.expiresAt.getTime() < Date.now();

const sendOtpMessage = async ({ recipient, channel, action, code }) => {
  const subject = `Your AeroPulse verification code`;
  const message = `Your AeroPulse ${action.replace("_", " ")} code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`;

  if (channel === "email") {
    if (!canSendEmail()) {
      throw new Error("Email delivery is not configured. Add an Infobip verified email sender and email API permission.");
    }
    await sendEmail({
      to: recipient,
      subject,
      text: `${message}\n\nIf you did not request this, ignore this message.`,
      html: `<p>${message}</p><p>If you did not request this, ignore this message.</p>`,
    });
    return;
  }

  if (channel === "sms") {
    await sendSmsViaInfobip({ recipient, message });
    return;
  }

  if (channel === "messenger") {
    console.log("[OTP] Messenger code:", code, "for", recipient);
    return;
  }
};

/**
 * SYMMETRICAL OTP HELPERS
 */
const createOtpRequest = async ({
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
  metadata = {},
}) => {
  const code = generateOtpCode();
  const codeHash = hashValue(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60 * 1000);

  const otpRequest = await OtpRequest.create({
    email: normalizeEmail(email),
    phone: canonicalizePhMobile(phone),
    messenger_handle: String(messenger_handle || "").trim(),
    action,
    channel,
    codeHash,
    requestedAt: now,
    expiresAt,
    metadata,
  });

  try {
    await sendOtpMessage({
      recipient: email || phone || messenger_handle,
      channel,
      action,
      code,
    });
  } catch (error) {
    await OtpRequest.deleteOne({ _id: otpRequest._id });
    throw error;
  }

  console.log("[OTP] Verification request created", {
    action,
    channel,
    recipient: email || phone || messenger_handle,
  });

  return { otpRequest, code };
};

const findOtpRequest = async ({
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
}) => {
  const query = { action, channel, verifiedAt: null };
  if (email) query.email = normalizeEmail(email);
  if (phone) query.phone = canonicalizePhMobile(phone);
  if (messenger_handle)
    query.messenger_handle = String(messenger_handle).trim();
  return OtpRequest.findOne(query).sort({ createdAt: -1 });
};

const verifyOtpRequest = async ({
  email = "",
  phone = "",
  messenger_handle = "",
  action,
  channel,
  code,
}) => {
  const otp = await findOtpRequest({
    email,
    phone,
    messenger_handle,
    action,
    channel,
  });
  if (!otp) return { ok: false, reason: "not_found" };
  if (isOtpExpired(otp)) return { ok: false, reason: "expired" };

  if (otp.codeHash !== hashValue(code)) return { ok: false, reason: "invalid" };

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

  // 1. Validation for specific actions
  if (action === "register_email" && !email) {
    return res.status(400).json({ message: "Email required." });
  }
  if (action === "register_phone" && !phone) {
    return res.status(400).json({ message: "Phone required." });
  }
  if (action === "register_messenger" && !messenger_handle) {
    return res.status(400).json({ message: "Messenger handle required." });
  }

  // 2. Uniqueness checks
  if (
    action === "register_email" &&
    (await User.findOne({ email: normalizeEmail(email) }))
  ) {
    return res.status(409).json({ message: "Email already exists." });
  }
  if (
    action === "register_phone" &&
    (await User.findOne({ phone: canonicalizePhMobile(phone) }))
  ) {
    return res.status(409).json({ message: "Phone already exists." });
  }

  try {
    const { code } = await createOtpRequest({
      email,
      phone,
      messenger_handle,
      action,
      channel,
    });

    return res.json({
      message: "Code sent successfully.",
      ...(env.nodeEnv === "production" ? {} : { debugCode: code }),
    });
  } catch (err) {
    console.error("[OTP] Error:", err);
    return res.status(502).json({
      message: err?.message || "SMS delivery could not be completed. Please try again.",
    });
  }
};

const verifyOtp = async (req, res) => {
  const { action, channel, email, phone, messenger_handle, code } = req.body;

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
      return res.status(400).json({ message: "Invalid or expired code." });
    }

    // Keep registration verification progress resumable for both web and mobile.
    if (action.startsWith("register_")) {
      const existing = req.session.registrationProgress || {};
      const data = existing.formData || {};
      if (action === "register_email") {
        data.email = normalizeEmail(email);
        data.emailVerified = true;
      } else if (action === "register_phone") {
        data.phone = canonicalizePhMobile(phone);
        data.phoneVerified = true;
      } else if (action === "register_messenger") {
        data.messengerHandle = messenger_handle;
        data.messengerVerified = true;
      }
      req.session.registrationProgress = {
        ...existing,
        email: normalizeEmail(email || existing.email || data.email),
        stepIndex: Math.max(1, Number(existing.stepIndex) || 0),
        formData: data,
      };
    }

    return req.session.save((error) => {
      if (error) return res.status(500).json({ message: "Unable to save verification progress." });
      return res.json({
        message: "Verification successful.",
        registrationProgress: req.session.registrationProgress || null,
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

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).json({ errors: { email: "Email already exists" } });
  }

  let finalSecret = "";
  let finalUri = "";
  let verifiedCode = null;

  // 1. Check for RESUME state in the session
  const progress = req.session.registrationProgress;
  if (
    progress &&
    normalizeEmail(progress.email || progress.formData?.email) === email
  ) {
    if (progress.formData?.registrationSecret) {
      finalSecret = progress.formData.registrationSecret;
      finalUri = progress.formData.provisioningUri;
      verifiedCode = progress.formData.verifiedCode;
    }
  }

  if (
    !finalSecret &&
    req.session.tempRegistrationSecret &&
    normalizeEmail(req.session.tempRegistrationEmail) === email
  ) {
    finalSecret = req.session.tempRegistrationSecret;
    finalUri = req.session.tempProvisioningUri;
  }

  // 2. FRESH START: If no session state, proactively PURGE all database artifacts for this email (Technical Cascade)
  if (!finalSecret) {
    console.log(
      `[BOUTIQUE] Fresh start for ${email}. Purging existing database artifacts...`,
    );
    await OtpRequest.deleteMany({ email });

    const secret = speakeasy.generateSecret({
      length: 20,
      name: `AeroPulse:${email}`,
    });
    finalSecret = secret.base32;
    finalUri = secret.otpauth_url;

    req.session.tempRegistrationSecret = finalSecret;
    req.session.tempProvisioningUri = finalUri;
    req.session.tempRegistrationEmail = email;

    // 3. Proactively DISPATCH the secret to the user's email if possible
    if (canSendEmail()) {
      try {
        await sendEmail({
          to: email,
          subject: "Your AeroPulse Security Secret",
          text: `Your boutique security secret is: ${finalSecret}\n\nEnter this code into your authenticator app or manually on the registration screen.`,
          html: `<p>Your boutique security secret is: <strong>${finalSecret}</strong></p><p>Enter this code into your authenticator app or manually on the registration screen.</p>`,
        });
      } catch (err) {
        console.error("[BOUTIQUE] Secret dispatch failed:", err.message);
      }
    }
  }

  const currentToken = speakeasy.totp({
    secret: finalSecret,
    encoding: "base32",
  });

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║ [TOTP] SECRET FOR:", email.padEnd(33, " "), "║");
  console.log("║ BASE32 SECRET:    ", finalSecret.padEnd(33, " "), "║");
  console.log("║ CURRENT TOKEN:    ", currentToken.padEnd(33, " "), "║");
  if (verifiedCode)
    console.log("║ STATUS:            ALREADY VERIFIED".padEnd(55, " "), "║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  return res.json({
    email,
    secret: finalSecret,
    provisioningUri: finalUri,
    verifiedCode,
  });
};

const verifyRegistrationCode = async (req, res) => {
  const { email, code, secret } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !code || !secret) {
    return res.status(400).json({ message: "Data required." });
  }

  const isValid = speakeasy.totp.verify({
    secret: secret,
    encoding: "base32",
    token: code,
    window: 1,
  });
  if (!isValid) return res.status(400).json({ message: "Invalid code." });

  // Mark in database as verified
  await OtpRequest.findOneAndUpdate(
    { email: normalizedEmail, action: "register_email", verifiedAt: null },
    { $set: { verifiedAt: new Date() } },
    { sort: { createdAt: -1 } },
  );

  req.session.registrationProgress = {
    email: normalizedEmail,
    stepIndex: 1,
    formData: {
      email: normalizedEmail,
      registrationSecret: secret,
      verifiedCode: code,
      emailVerified: true,
    },
  };

  return req.session.save((error) => {
    if (error) return res.status(500).json({ message: "Unable to save email verification." });
    return res.json({
      message: "Success",
      registrationProgress: req.session.registrationProgress,
    });
  });
};

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
    role,
    branch,
  } = req.body;
  try {
    const normalizedEmail = normalizeEmail(email);
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Auto-generate alias from email if not provided (Technical Fallback)
    const finalAlias = (alias || normalizedEmail.split("@")[0] || "")
      .toLowerCase()
      .trim();

    const primaryLoc = locations[0] || null;
    const addressString = primaryLoc
      ? `${primaryLoc.address.street}, ${primaryLoc.address.city}, ${primaryLoc.address.province}`.trim()
      : "";

    const newUser = await User.create({
      name: `${name_first} ${name_last}`,
      name_first,
      name_last,
      alias: finalAlias,
      email: normalizedEmail,
      phone: canonicalizePhMobile(phone),
      passwordHash,
      messenger_handle,
      role: role || "customer",
      assignedBranch: branch || "",
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
      contact_method: contact_method || "",
      billingAddress: primaryLoc ? primaryLoc.address : {},
      location: primaryLoc || { address: {}, coordinates: {} },
      delivery_instructions: delivery_instructions || "",
      addresses: locations.map((loc, idx) => ({
        ...loc.address,
        label: `Facility ${idx + 1}`,
        isDefault: idx === 0,
      })),
      accountStatus: "active",
    });

    // Final database purge for this email after successful registration
    await OtpRequest.deleteMany({ email: normalizedEmail });
    if (req.session) req.session.destroy();

    const token = signAccessToken({ sub: newUser.id, role: newUser.role });
    return res.json({ success: true, token, user: newUser.toJSON() });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const login = async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const normalizedIdentifier = normalizeIdentifier(identifier);
    const normalizedPhone = normalizePhone(identifier);
    const lookupConditions = [
      { email: normalizedIdentifier },
      { alias: normalizedIdentifier },
      { username: normalizedIdentifier },
    ];
    if (normalizedPhone) {
      lookupConditions.push({ phone: normalizedPhone });
    }
    // STRICT ALIAS LOGIN: Email is excluded to prioritize technical identity
    const user = await User.findOne({
      $or: lookupConditions,
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = signAccessToken({ sub: user.id, role: user.role });
    return res.json({ success: true, token, user: user.toJSON() });
  } catch (err) {
    return res.status(500).json({ message: "Login error" });
  }
};

const logout = async (req, res) => {
  console.log("[BOUTIQUE] Nuclear session & database purge initiated...");
  try {
    const email =
      req.session?.registrationProgress?.email ||
      req.session?.tempRegistrationEmail;
    if (email) {
      const deleted = await OtpRequest.deleteMany({
        email: normalizeEmail(email),
      });
      console.log(
        `[BOUTIQUE] Purged ${deleted.deletedCount} technical identifiers for ${email}.`,
      );
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

  const existing = req.session.registrationProgress || {};
  const incomingForm = incoming.formData && typeof incoming.formData === "object"
    ? incoming.formData
    : {};
  const existingForm = existing.formData && typeof existing.formData === "object"
    ? existing.formData
    : {};
  const email = normalizeEmail(incoming.email || existing.email || incomingForm.email || existingForm.email);

  // Passwords belong only in the encrypted browser draft and final register
  // request. This session is for resumable verification and form progress.
  delete incomingForm.password;
  delete incomingForm.confirmPassword;

  const mergedForm = {
    ...existingForm,
    ...incomingForm,
    email: email || existingForm.email || "",
    registrationSecret: existingForm.registrationSecret || incomingForm.registrationSecret || "",
    provisioningUri: existingForm.provisioningUri || incomingForm.provisioningUri || "",
    verifiedCode: existingForm.verifiedCode || incomingForm.verifiedCode || "",
    emailVerified: Boolean(existingForm.emailVerified || existingForm.verifiedCode || incomingForm.emailVerified),
  };

  req.session.registrationProgress = {
    email,
    stepIndex: Math.max(0, Math.min(Number(incoming.stepIndex) || 0, 4)),
    formData: mergedForm,
  };
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
  const email = normalizeEmail(req.body.email);
  const user = await User.findOne({ email });
  if (!user) return res.json({ message: "If email exists, code sent." });
  const { code } = await createOtpRequest({
    email,
    action: "password_reset",
    channel: "email",
  });
  res.json({ message: "Code sent.", debugCode: code });
};

const resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(decoded.sub);
    if (!user) return res.status(404).json({ message: "User not found" });
    const salt = await bcrypt.genSalt(10);
    user.passwordHash = await bcrypt.hash(password, salt);
    await user.save();
    res.json({ message: "Success" });
  } catch (err) {
    res.status(400).json({ message: "Invalid token." });
  }
};

const resetPasswordWithCode = async (req, res) => {
  const { email, code, newPassword } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const verification = await verifyOtpRequest({
    email: normalizedEmail,
    action: "password_reset",
    channel: "email",
    code,
  });
  if (!verification.ok)
    return res.status(400).json({ message: "Invalid code." });
  const user = await User.findOne({ email: normalizedEmail });
  const salt = await bcrypt.genSalt(10);
  user.passwordHash = await bcrypt.hash(newPassword, salt);
  await user.save();
  res.json({ message: "Success" });
};

module.exports = {
  startRegistration,
  verifyRegistrationCode,
  register,
  login,
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
