const User = require("../models/User");
const bcrypt = require("bcryptjs");
const { signUserAccessToken } = require("../utils/token");
const { invalidateAuthCache } = require("../middleware/auth");
const {
  buildTotpSetup,
  decryptSecret,
  encryptSecret,
  findRecoveryCodeIndex,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotpCode,
} = require("../domain/accountSecurity");
const { SHARED_DEMO_EMAIL } = require("../domain/demoStaffPolicy");

const normalizeIdentifier = (value = "") => String(value).trim().toLowerCase();
const normalizePhone = (value = "") => String(value).replace(/\D/g, "");
// The authenticator label must remain account-specific even when approved demo
// staff intentionally share a delivery email address.
const displayAccountName = (user = {}) => user.alias || user.username || user.id || user.email || "account";

const securityStatus = (user = {}) => ({
  totpEnabled: Boolean(user.security?.totpEnabled),
  totpResetRequired: Boolean(user.security?.totpResetRequired),
  totpSetupPending: Boolean(user.security?.totpPendingSecretEncrypted),
  recoveryCodesConfigured: Number(user.security?.recoveryCodesRemaining || 0) > 0,
  recoveryCodesRemaining: Number(user.security?.recoveryCodesRemaining || 0),
  recoveryCodesGeneratedAt: user.security?.recoveryCodesGeneratedAt || null,
});

const getSecurityStatus = async (req, res) => {
  const user = await User.findById(req.authUser._id).select("+security.totpPendingSecretEncrypted");
  if (!user) return res.status(404).json({ message: "Account not found." });
  return res.json({ security: securityStatus(user) });
};

const beginTotpSetup = async (req, res) => {
  try {
    const user = await User.findById(req.authUser._id).select("+security.totpPendingSecretEncrypted");
    if (!user) return res.status(404).json({ message: "Account not found." });
    let secret = "";
    if (user.security?.totpPendingSecretEncrypted && req.body?.regenerate !== true) {
      try {
        secret = decryptSecret(user.security.totpPendingSecretEncrypted);
      } catch (_error) {
        secret = "";
      }
    }
    let provisioningUri = "";
    if (!secret) {
      const setup = buildTotpSetup({ accountName: displayAccountName(user) });
      secret = setup.secret;
      provisioningUri = setup.provisioningUri;
      user.security = user.security || {};
      user.security.totpPendingSecretEncrypted = encryptSecret(secret);
      await user.save();
    } else {
      const issuer = encodeURIComponent("ColdAir");
      const account = encodeURIComponent(displayAccountName(user));
      provisioningUri = `otpauth://totp/${issuer}:${account}?secret=${encodeURIComponent(secret)}&issuer=${issuer}`;
    }
    return res.json({
      secret,
      provisioningUri,
      security: securityStatus(user),
    });
  } catch (error) {
    console.error("Unable to begin authenticator setup:", error.message);
    return res.status(500).json({ message: "Unable to start authenticator setup." });
  }
};

const verifyTotpSetup = async (req, res) => {
  try {
    const user = await User.findById(req.authUser._id).select("+security.totpPendingSecretEncrypted");
    if (!user?.security?.totpPendingSecretEncrypted) {
      return res.status(400).json({ message: "Start authenticator setup before verifying a code." });
    }
    let secret;
    try {
      secret = decryptSecret(user.security.totpPendingSecretEncrypted);
    } catch (_error) {
      return res.status(400).json({ message: "Authenticator setup expired. Generate a new setup code." });
    }
    if (!verifyTotpCode({ secret, code: req.body?.code })) {
      return res.status(400).json({ message: "Incorrect authenticator code." });
    }
    const version = Number(user.security.sessionVersion || 0);
    const verified = await User.findOneAndUpdate({
      _id: user._id, "security.totpPendingSecretEncrypted": user.security.totpPendingSecretEncrypted,
      ...(version ? { "security.sessionVersion": version } : { $or: [{ "security.sessionVersion": 0 }, { "security.sessionVersion": { $exists: false } }] }),
    }, {
      $set: { "security.totpSecretEncrypted": user.security.totpPendingSecretEncrypted,
        "security.totpPendingSecretEncrypted": "", "security.totpEnabled": true,
        "security.totpResetRequired": false, "security.totpVerifiedAt": new Date(),
        ...(user.role === "technician" && !user.isFirstLogin && !user.technicianOnboardedAt ? { technicianOnboardedAt: new Date() } : {}) },
      $inc: { "security.sessionVersion": 1 },
    }, { new: true });
    if (!verified) return res.status(409).json({ message: "Authenticator setup changed. Reload setup and try again." });
    invalidateAuthCache(verified.id);
    const token = signUserAccessToken(verified);
    return res.json({
      message: "Authenticator verification enabled.",
      security: securityStatus(verified),
      user: verified.toJSON(),
      token,
    });
  } catch (error) {
    console.error("Unable to verify authenticator setup:", error.message);
    return res.status(500).json({ message: "Unable to verify the authenticator code." });
  }
};

const listRecoveryCodes = async (req, res) => res.json({
  codes: [],
  shownOnce: true,
  security: securityStatus(req.authUser),
});

const regenerateRecoveryCodes = async (req, res) => {
  const codes = generateRecoveryCodes();
  const user = await User.findById(req.authUser._id).select("+security.recoveryCodeHashes");
  if (!user) return res.status(404).json({ message: "Account not found." });
  user.security = user.security || {};
  user.security.recoveryCodeHashes = codes.map(hashRecoveryCode);
  user.security.recoveryCodesRemaining = codes.length;
  user.security.recoveryCodesGeneratedAt = new Date();
  await user.save();
  return res.json({
    codes: codes.map((code) => ({ code, used: false })),
    shownOnce: true,
    security: securityStatus(user),
  });
};

const resetTotpAuthenticator = async (req, res) => {
  try {
    const user = await User.findById(req.authUser._id).select(
      "+security.totpSecretEncrypted +security.totpPendingSecretEncrypted +security.recoveryCodeHashes",
    );
    if (!user) return res.status(404).json({ message: "Account not found." });

    const currentPassword = String(req.body?.currentPassword || "");
    const currentCode = String(req.body?.currentCode || "").trim();
    if (user.passwordHash) {
      if (!currentPassword) {
        return res.status(400).json({ message: "Enter your current password." });
      }
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        return res.status(400).json({ message: "Current password is incorrect." });
      }
    }

    if (user.security?.totpEnabled) {
      let secret = "";
      try {
        secret = decryptSecret(user.security.totpSecretEncrypted);
      } catch (_error) {
        secret = "";
      }
      if (!secret) {
        return res.status(409).json({
          message: "Your authenticator needs recovery. Use a saved recovery code or contact support.",
        });
      }
      if (!verifyTotpCode({ secret, code: currentCode })) {
        return res.status(400).json({ message: "Current authenticator code is incorrect." });
      }
    }

    const version = Number(user.security?.sessionVersion || 0);
    const resetUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        ...(version
          ? { "security.sessionVersion": version }
          : {
              $or: [
                { "security.sessionVersion": 0 },
                { "security.sessionVersion": { $exists: false } },
              ],
            }),
      },
      {
        $set: {
          "security.totpEnabled": false,
          "security.totpResetRequired": true,
          "security.totpSecretEncrypted": "",
          "security.totpPendingSecretEncrypted": "",
          "security.totpVerifiedAt": null,
          "security.recoveryCodeHashes": [],
          "security.recoveryCodesRemaining": 0,
          "security.recoveryCodesGeneratedAt": null,
        },
        $inc: { "security.sessionVersion": 1 },
      },
      { new: true },
    );
    if (!resetUser) {
      return res.status(409).json({
        message: "Account security changed in another session. Sign in again and retry.",
      });
    }

    invalidateAuthCache(resetUser.id);
    const token = signUserAccessToken(
      resetUser,
      { recovery: true },
      { expiresIn: "15m" },
    );
    return res.json({
      message: "Authenticator reset confirmed. Set up and verify a new authenticator now.",
      token,
      user: resetUser.toJSON(),
      security: securityStatus(resetUser),
      requiresTotpReset: true,
    });
  } catch (error) {
    console.error("Unable to reset authenticator:", error.message);
    return res.status(500).json({ message: "Unable to reset the authenticator." });
  }
};

const consumeRecoveryCode = async (req, res) => {
  try {
    const identifier = normalizeIdentifier(req.body?.identifier || req.body?.email || "");
    const normalizedCode = normalizeRecoveryCode(req.body?.code);
    if (!identifier || normalizedCode.length !== 12) {
      return res.status(400).json({ message: "Enter your account identifier and 12-character recovery code." });
    }
    if (identifier === SHARED_DEMO_EMAIL) {
      return res.status(409).json({
        message: "This demo email belongs to multiple accounts. Enter the account's unique login ID instead.",
      });
    }
    const phone = normalizePhone(identifier);
    const conditions = [
      { email: identifier },
      { alias: identifier },
      { username: identifier },
    ];
    if (phone) conditions.push({ phone });
    const user = await User.findOne({ $or: conditions }).select(
      "+security.recoveryCodeHashes +security.totpSecretEncrypted +security.totpPendingSecretEncrypted",
    );
    if (!user || user.isDeleted || ["disabled", "deleted"].includes(String(user.accountStatus || ""))) {
      return res.status(400).json({ message: "Invalid or already-used recovery code." });
    }
    if (user.role === "technician") return res.status(400).json({ message: "Sign in with your technician username and password. Contact your administrator if you need a password reset." });
    const hashes = Array.isArray(user.security?.recoveryCodeHashes)
      ? user.security.recoveryCodeHashes
      : [];
    const matchIndex = findRecoveryCodeIndex(hashes, normalizedCode);
    if (matchIndex < 0) {
      return res.status(400).json({ message: "Invalid or already-used recovery code." });
    }
    // Atomically consume the hash: concurrent requests cannot use one code twice.
    const recovered = await User.findOneAndUpdate({
      _id: user._id, "security.recoveryCodeHashes": hashes[matchIndex],
      isDeleted: { $ne: true }, accountStatus: { $nin: ["disabled", "deleted"] },
    }, {
      $pull: { "security.recoveryCodeHashes": hashes[matchIndex] },
      $inc: { "security.recoveryCodesRemaining": -1, "security.sessionVersion": 1 },
      $set: { "security.totpEnabled": false, "security.totpResetRequired": true,
        "security.totpSecretEncrypted": "", "security.totpPendingSecretEncrypted": "",
        "security.recoveredAt": new Date(), lastLogin: new Date() },
    }, { new: true });
    if (!recovered) return res.status(400).json({ message: "Invalid or already-used recovery code." });
    invalidateAuthCache(recovered.id);
    const token = signUserAccessToken(
      recovered, { recovery: true },
      { expiresIn: "15m" },
    );
    return res.json({
      success: true,
      token,
      user: recovered.toJSON(),
      requiresTotpReset: true,
      recoveryDestination: user.role === "technician"
        ? "/technician/oobe/reset"
        : "/customer/oobe/reset",
    });
  } catch (error) {
    console.error("Recovery code verification failed:", error.message);
    return res.status(500).json({ message: "Unable to verify the recovery code." });
  }
};

module.exports = {
  beginTotpSetup,
  consumeRecoveryCode,
  getSecurityStatus,
  listRecoveryCodes,
  regenerateRecoveryCodes,
  resetTotpAuthenticator,
  verifyTotpSetup,
};
