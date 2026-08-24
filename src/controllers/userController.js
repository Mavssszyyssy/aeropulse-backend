const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");
const Order = require("../models/Order");
const Notification = require("../models/Notification");
const { notifyOperationalStaff } = require("../services/operationalNotificationService");
const { resolveConfiguredBranch } = require("../services/branchCoverageService");
const env = require("../config/env");
const { canSendEmail, sendEmail } = require("../utils/email");

const PROFILE_VISIBILITY_VALUES = ["public", "private", "role_based"];
const NOTIFICATION_TYPES = ["account", "order", "system"];
const PASSWORD_RESET_MINUTES = Math.max(
  15,
  Math.min(30, Number(env.passwordResetTokenTtlMinutes || 20)),
);

const generatePasswordResetToken = () => {
  const nonce = crypto.randomBytes(24).toString("hex");
  const createdAt = Date.now().toString();
  const payload = `${nonce}.${createdAt}`;
  const signature = crypto
    .createHmac("sha256", env.passwordResetTokenSecret)
    .update(payload)
    .digest("hex");
  const token = `${payload}.${signature}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
};

const normalizePhone = (phone = "") => String(phone).replace(/\D/g, "");
const canonicalizePhMobile = (phone = "") => {
  const digits = normalizePhone(phone);
  if (/^639\d{9}$/.test(digits)) {
    return `09${digits.slice(3)}`;
  }
  return digits;
};
const isValidPhMobile = (phone = "") =>
  /^09\d{9}$/.test(canonicalizePhMobile(phone));
const sanitizeText = (value = "", maxLength = 120) =>
  String(value || "")
    .trim()
    .slice(0, maxLength);
const sanitizeOptionalUsername = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase();
const isValidUsername = (value = "") =>
  !value || /^[a-z0-9_.-]{3,30}$/.test(value);
const isAllowedAvatarUrl = (value = "") => {
  const avatar = String(value || "").trim();
  if (!avatar) return true;
  if (avatar.length > 2_000_000) return false;
  if (/^https?:\/\//i.test(avatar)) return true;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(avatar))
    return true;
  return false;
};
const sanitizeAddressPayload = (payload = {}) => {
  const label = sanitizeText(payload.label, 80);
  const type = ["home", "office", "other"].includes(payload.type)
    ? payload.type
    : "other";
  const name = sanitizeText(payload.name, 120);
  const region = sanitizeText(payload.region, 120);
  const province = sanitizeText(payload.province, 120);
  const street = sanitizeText(payload.street, 180);
  const barangay = sanitizeText(payload.barangay, 120);
  const city = sanitizeText(payload.city, 120);
  const postalCode = sanitizeText(payload.postalCode, 20);
  const phone = canonicalizePhMobile(payload.phone || "");

  return {
    label,
    type,
    name,
    region,
    province,
    street,
    barangay,
    city,
    postalCode,
    phone,
    isDefault: Boolean(payload.isDefault),
  };
};
const validateAddress = (address = {}) => {
  const errors = {};
  if (!address.name || !String(address.name).trim()) {
    errors.name = "Recipient name is required";
  }
  if (!address.region || !String(address.region).trim()) {
    errors.region = "Region is required";
  }
  if (!address.province || !String(address.province).trim()) {
    errors.province = "Province is required";
  }
  if (!address.barangay || !String(address.barangay).trim()) {
    errors.barangay = "Barangay is required";
  }
  if (!address.street || !String(address.street).trim()) {
    errors.street = "Street address is required";
  }
  if (!address.city || !String(address.city).trim()) {
    errors.city = "City is required";
  }
  if (!address.phone || !String(address.phone).trim()) {
    errors.phone = "Phone number is required";
  } else if (!/^09\d{9}$/.test(address.phone)) {
    errors.phone = "Phone number must be in format 09XXXXXXXXX";
  }
  if (address.postalCode && !/^\d{4}$/.test(address.postalCode)) {
    errors.postalCode = "Postal code must be exactly 4 digits";
  }
  return Object.keys(errors).length > 0 ? errors : null;
};
const normalizeDefaultAddress = (addresses = []) => {
  if (addresses.length === 0) return;
  const requestedDefaultIndex = addresses.findIndex((item) => item.isDefault);
  const defaultIndex = requestedDefaultIndex >= 0 ? requestedDefaultIndex : 0;
  addresses.forEach((item, index) => {
    item.isDefault = index === defaultIndex;
  });
};
const formatAddressLine = (address = {}) =>
  [
    address.street,
    address.barangay,
    address.city,
    address.province,
    address.region,
  ]
    .map((part) => sanitizeText(part, 180))
    .filter(Boolean)
    .join(", ");
const syncPrimaryAddressFromDefault = (user, addresses = []) => {
  const defaultAddress =
    addresses.find((item) => item.isDefault) || addresses[0] || null;
  if (!defaultAddress) {
    user.billingAddress = {
      region: "",
      province: "",
      city: "",
      barangay: "",
      street: "",
    };
    user.address = "";
    return;
  }

  user.billingAddress = {
    region: sanitizeText(defaultAddress.region, 120),
    province: sanitizeText(defaultAddress.province, 120),
    city: sanitizeText(defaultAddress.city, 120),
    barangay: sanitizeText(defaultAddress.barangay, 120),
    street: sanitizeText(defaultAddress.street, 180),
  };
  user.address = formatAddressLine(defaultAddress);
};

// The default saved address is the source of truth for a customer's service
// branch. Clear a previous branch when the new address has no coverage match.
const syncCustomerBranchFromDefault = async (user, addresses = []) => {
  if (user.role !== "customer") return;
  const address = addresses.find((item) => item.isDefault) || addresses[0] || null;
  const branch = address ? await resolveConfiguredBranch(address) : null;
  const branchName = branch?.name || "";
  user.assignedBranch = branchName;
  user.activeBranch = branchName;
};

const hasLegacyAddressData = (user) => Boolean(
  user?.address ||
  user?.thoroughfare ||
  user?.municipality ||
  user?.submunicipality ||
  user?.billingAddress?.street ||
  user?.billingAddress?.city,
);

// Profile settings use legacy fields while checkout uses the saved-address
// list. Keep the default saved address current whenever the profile changes.
const syncDefaultAddressFromProfile = (user) => {
  const addresses = Array.isArray(user.addresses)
    ? user.addresses.map((item) => item?.toObject?.() || item)
    : [];
  const defaultIndex = addresses.findIndex((item) => item?.isDefault);
  const index = defaultIndex >= 0 ? defaultIndex : 0;
  const existing = addresses[index] || {};
  const billing = user.billingAddress?.toObject?.() || user.billingAddress || {};
  const street = [user.apartment_unit, user.property_block_lot, user.thoroughfare]
    .map((value) => sanitizeText(value, 180))
    .filter(Boolean)
    .join(", ");

  const nextAddress = {
    ...existing,
    label: existing.label || "Primary Address",
    type: existing.type || "home",
    name:
      sanitizeText(user.name, 120) ||
      [user.name_first, user.name_last]
        .map((value) => sanitizeText(value, 80))
        .filter(Boolean)
        .join(" ") ||
      existing.name ||
      "Customer",
    phone: canonicalizePhMobile(user.phone || existing.phone || ""),
    region: sanitizeText(billing.region, 120) || existing.region || "",
    province: sanitizeText(billing.province, 120) || existing.province || "",
    city: sanitizeText(user.municipality, 120) || sanitizeText(billing.city, 120) || existing.city || "",
    barangay:
      sanitizeText(user.submunicipality, 120) ||
      sanitizeText(billing.barangay, 120) ||
      existing.barangay ||
      "",
    street: street || sanitizeText(billing.street, 180) || existing.street || sanitizeText(user.address, 180),
    isDefault: true,
  };

  // A customer may intentionally skip delivery address collection at sign-up.
  // Profile-only updates (such as changing a name or mobile number) must not
  // manufacture an incomplete address record for that account.
  const hasAddressDetails = [
    nextAddress.region,
    nextAddress.province,
    nextAddress.city,
    nextAddress.barangay,
    nextAddress.street,
  ].some((value) => Boolean(sanitizeText(value, 180)));
  if (addresses.length === 0 && !hasAddressDetails) return;

  if (addresses.length === 0) addresses.push(nextAddress);
  else addresses[index] = nextAddress;
  normalizeDefaultAddress(addresses);
  user.addresses = addresses;
  syncPrimaryAddressFromDefault(user, addresses);
};

const normalizePreferences = (current, payload = {}) => {
  const next = { ...current };
  if (payload.language !== undefined)
    next.language = sanitizeText(payload.language, 40) || "English";
  if (payload.currency !== undefined)
    next.currency = sanitizeText(payload.currency, 10) || "PHP";
  if (payload.timezone !== undefined)
    next.timezone = sanitizeText(payload.timezone, 80) || "Asia/Manila";
  if (payload.autoBook !== undefined) next.autoBook = Boolean(payload.autoBook);
  if (payload.darkMode !== undefined) {
    next.darkMode = Boolean(payload.darkMode);
    next.theme = next.darkMode ? "dark" : "light";
  }
  if (payload.theme !== undefined) {
    const normalizedTheme = String(payload.theme || "").toLowerCase();
    if (["light", "dark"].includes(normalizedTheme)) {
      next.theme = normalizedTheme;
      next.darkMode = normalizedTheme === "dark";
    }
  }
  return next;
};

const normalizePrivacy = (current, payload = {}) => {
  const next = { ...current };
  if (payload.profileVisibility !== undefined) {
    const visibility = String(payload.profileVisibility || "").toLowerCase();
    next.profileVisibility = PROFILE_VISIBILITY_VALUES.includes(visibility)
      ? visibility
      : current.profileVisibility;
  }
  if (payload.dataSharing !== undefined)
    next.dataSharing = Boolean(payload.dataSharing);
  if (payload.showEmail !== undefined)
    next.showEmail = Boolean(payload.showEmail);
  if (payload.showPhone !== undefined)
    next.showPhone = Boolean(payload.showPhone);
  if (payload.activityStatus !== undefined)
    next.activityStatus = Boolean(payload.activityStatus);
  return next;
};

const normalizeNotifications = (current, payload = {}) => {
  const next = { ...current };
  const booleanKeys = [
    "email",
    "inApp",
    "push",
    "sms",
    "accountUpdates",
    "orderUpdates",
    "systemAlerts",
    "promotions",
    "serviceUpdates",
  ];
  booleanKeys.forEach((key) => {
    if (payload[key] !== undefined) {
      next[key] = Boolean(payload[key]);
    }
  });

  // Keep backward compatibility with legacy push key.
  next.push = Boolean(next.inApp ?? next.push);
  next.inApp = Boolean(next.inApp ?? next.push);
  return next;
};

const isStrongPassword = (value = "") => {
  const password = String(value);
  if (password.length < 8) return false;
  if (!/(?=.*[a-z])/.test(password)) return false;
  if (!/(?=.*[A-Z])/.test(password)) return false;
  if (!/(?=.*\d)/.test(password)) return false;
  if (!/(?=.*[@$!%*?&])/.test(password)) return false;
  return true;
};

const canManageTargetProfile = (manager, target) => {
  if (!manager || !target) return false;
  if (String(manager._id) === String(target._id)) return true;
  if (manager.role === "superadmin") return true;
  if (manager.role === "admin") {
    return target.role === "customer" || target.role === "technician";
  }
  return false;
};

const applyProfileUpdate = async (
  user,
  payload = {},
  { allowEmailChange = false } = {},
) => {
  if (payload.name !== undefined) user.name = sanitizeText(payload.name, 120);
  if (payload.name_first !== undefined)
    user.name_first = sanitizeText(payload.name_first, 80);
  if (payload.name_last !== undefined)
    user.name_last = sanitizeText(payload.name_last, 80);
  if (payload.alias !== undefined) {
    const alias = String(payload.alias || "")
      .trim()
      .toLowerCase();
    if (alias) {
      const existing = await User.findOne({
        alias,
        _id: { $ne: user._id },
      }).select("_id");
      if (existing) {
        return { ok: false, status: 409, message: "Alias is already taken." };
      }
      user.alias = alias;
    } else {
      user.alias = undefined;
    }
  }
  if (payload.username !== undefined) {
    const username = sanitizeOptionalUsername(payload.username);
    if (!isValidUsername(username)) {
      return {
        ok: false,
        status: 400,
        message:
          "Username must be 3-30 chars and can only contain letters, numbers, _, ., -",
      };
    }

    if (username) {
      const existing = await User.findOne({
        username,
        _id: { $ne: user._id },
      }).select("_id");
      if (existing) {
        return {
          ok: false,
          status: 409,
          message: "Username is already taken.",
        };
      }
      user.username = username;
    } else {
      user.username = undefined;
    }
  }

  if (payload.phone !== undefined) {
    if (!isValidPhMobile(payload.phone)) {
      return {
        ok: false,
        status: 400,
        message: "Invalid phone number format. Use 09XXXXXXXXX.",
      };
    }
    const normalizedPhone = canonicalizePhMobile(payload.phone);
    const existingPhoneUser = await User.findOne({
      phone: normalizedPhone,
      _id: { $ne: user._id },
    }).select("_id");
    if (existingPhoneUser) {
      return {
        ok: false,
        status: 409,
        message: "Phone number is already in use.",
      };
    }
    user.phone = normalizedPhone;
  }

  if (payload.avatarUrl !== undefined) {
    const avatar = String(payload.avatarUrl || "").trim();
    if (!isAllowedAvatarUrl(avatar)) {
      return {
        ok: false,
        status: 400,
        message: "Invalid profile picture format.",
      };
    }
    user.avatarUrl = avatar;
  }

  if (payload.address !== undefined) {
    user.address = sanitizeText(payload.address, 220);
  }

  [
    ["municipality", 120],
    ["municipality_code", 40],
    ["submunicipality", 120],
    ["submunicipality_code", 40],
    ["thoroughfare", 180],
    ["property_block_lot", 120],
    ["apartment_unit", 120],
    ["landmark", 180],
    ["plus_code", 80],
    ["contact_method", 60],
    ["messenger_handle", 120],
    ["delivery_instructions", 220],
  ].forEach(([field, maxLength]) => {
    if (payload[field] !== undefined) {
      user[field] = sanitizeText(payload[field], maxLength);
    }
  });

  if (
    payload.billingAddress !== undefined &&
    payload.billingAddress &&
    typeof payload.billingAddress === "object"
  ) {
    const normalizedBillingAddress = {
      region: sanitizeText(payload.billingAddress.region, 120),
      province: sanitizeText(payload.billingAddress.province, 120),
      city: sanitizeText(payload.billingAddress.city, 120),
      barangay: sanitizeText(payload.billingAddress.barangay, 120),
      street: sanitizeText(payload.billingAddress.street, 180),
    };
    user.billingAddress = normalizedBillingAddress;
    user.address = formatAddressLine(normalizedBillingAddress) || user.address;
  }

  if (allowEmailChange && payload.email !== undefined) {
    // Placeholder for a future verified-email-change flow.
  }

  const hasProfileAddressUpdate = [
    "address",
    "billingAddress",
    "municipality",
    "submunicipality",
    "thoroughfare",
    "property_block_lot",
    "apartment_unit",
  ].some((field) => payload[field] !== undefined);
  if (hasProfileAddressUpdate) syncDefaultAddressFromProfile(user);

  return { ok: true };
};

const getProfile = async (req, res) => {
  return res.json({ user: req.authUser.toJSON() });
};

const getProfileById = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target || target.isDeleted || target.accountStatus === "deleted") {
    return res.status(404).json({ message: "User not found" });
  }

  if (!canManageTargetProfile(req.authUser, target)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  return res.json({ user: target.toJSON() });
};

const updateProfile = async (req, res) => {
  const result = await applyProfileUpdate(req.authUser, req.body || {});
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  await syncCustomerBranchFromDefault(req.authUser, req.authUser.addresses || []);
  await req.authUser.save();
  return res.json({ user: req.authUser.toJSON() });
};

const updateProfileById = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target || target.isDeleted || target.accountStatus === "deleted") {
    return res.status(404).json({ message: "User not found" });
  }

  if (!canManageTargetProfile(req.authUser, target)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const result = await applyProfileUpdate(target, req.body || {});
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  await syncCustomerBranchFromDefault(target, target.addresses || []);
  await target.save();
  return res.json({ user: target.toJSON() });
};

const listAddresses = async (req, res) => {
  let addresses = Array.isArray(req.authUser.addresses)
    ? req.authUser.addresses
    : [];

  // Accounts created before saved addresses were introduced still have the
  // sign-up/profile address fields. Materialize that same address as the
  // default checkout address instead of asking the customer to enter it again.
  if (addresses.length === 0 && hasLegacyAddressData(req.authUser)) {
    syncDefaultAddressFromProfile(req.authUser);
    await syncCustomerBranchFromDefault(req.authUser, req.authUser.addresses || []);
    await req.authUser.save();
    addresses = req.authUser.addresses || [];
  }

  return res.json({ addresses });
};

const addAddress = async (req, res) => {
  const normalizedAddress = sanitizeAddressPayload(req.body || {});
  const validationErrors = validateAddress(normalizedAddress);
  if (validationErrors) {
    return res.status(400).json({ errors: validationErrors });
  }

  const user = req.authUser;
  const nextAddresses = Array.isArray(user.addresses)
    ? [...user.addresses]
    : [];
  const shouldSetDefault =
    normalizedAddress.isDefault || nextAddresses.length === 0;
  nextAddresses.push({ ...normalizedAddress, isDefault: shouldSetDefault });
  normalizeDefaultAddress(nextAddresses);
  user.addresses = nextAddresses;
  syncPrimaryAddressFromDefault(user, nextAddresses);
  await syncCustomerBranchFromDefault(user, nextAddresses);

  await user.save();
  return res.status(201).json({ addresses: user.addresses });
};

const updateAddress = async (req, res) => {
  const addressId = String(req.params.addressId || "").trim();
  const user = req.authUser;
  const nextAddresses = Array.isArray(user.addresses)
    ? [...user.addresses]
    : [];
  const index = nextAddresses.findIndex(
    (item) => String(item._id) === addressId,
  );
  if (index < 0) {
    return res.status(404).json({ message: "Address not found" });
  }

  const normalizedAddress = sanitizeAddressPayload(req.body || {});
  const validationErrors = validateAddress(normalizedAddress);
  if (validationErrors) {
    return res.status(400).json({ errors: validationErrors });
  }

  nextAddresses[index] = {
    ...nextAddresses[index].toObject(),
    ...normalizedAddress,
  };
  normalizeDefaultAddress(nextAddresses);
  user.addresses = nextAddresses;
  syncPrimaryAddressFromDefault(user, nextAddresses);
  await syncCustomerBranchFromDefault(user, nextAddresses);

  await user.save();
  return res.json({ addresses: user.addresses });
};

const deleteAddress = async (req, res) => {
  const addressId = String(req.params.addressId || "").trim();
  const user = req.authUser;
  const current = Array.isArray(user.addresses) ? user.addresses : [];
  const nextAddresses = current.filter(
    (item) => String(item._id) !== addressId,
  );

  if (nextAddresses.length === current.length) {
    return res.status(404).json({ message: "Address not found." });
  }

  normalizeDefaultAddress(nextAddresses);
  user.addresses = nextAddresses;
  syncPrimaryAddressFromDefault(user, nextAddresses);
  await syncCustomerBranchFromDefault(user, nextAddresses);
  await user.save();
  return res.json({ addresses: user.addresses });
};

const setDefaultAddress = async (req, res) => {
  const addressId = String(req.params.addressId || "").trim();
  const user = req.authUser;
  const nextAddresses = Array.isArray(user.addresses)
    ? [...user.addresses]
    : [];
  const exists = nextAddresses.some((item) => String(item._id) === addressId);
  if (!exists) {
    return res.status(404).json({ message: "Address not found." });
  }

  nextAddresses.forEach((item) => {
    item.isDefault = String(item._id) === addressId;
  });
  user.addresses = nextAddresses;
  syncPrimaryAddressFromDefault(user, nextAddresses);
  await syncCustomerBranchFromDefault(user, nextAddresses);
  await user.save();
  return res.json({ addresses: user.addresses });
};

const updateSettings = async (req, res) => {
  const payload = req.body || {};
  const preferencesPayload = payload.preferences || payload;
  const privacyPayload = payload.privacy || payload;
  const notificationsPayload = payload.notifications || payload;

  req.authUser.preferences = normalizePreferences(
    req.authUser.preferences?.toObject?.() || req.authUser.preferences || {},
    preferencesPayload,
  );
  req.authUser.privacy = normalizePrivacy(
    req.authUser.privacy?.toObject?.() || req.authUser.privacy || {},
    privacyPayload,
  );
  req.authUser.notifications = normalizeNotifications(
    req.authUser.notifications?.toObject?.() ||
      req.authUser.notifications ||
      {},
    notificationsPayload,
  );

  await req.authUser.save();
  return res.json({ user: req.authUser.toJSON() });
};

const updatePreferences = async (req, res) => {
  req.authUser.preferences = normalizePreferences(
    req.authUser.preferences?.toObject?.() || req.authUser.preferences || {},
    req.body || {},
  );
  await req.authUser.save();
  return res.json({ user: req.authUser.toJSON() });
};

const updatePrivacy = async (req, res) => {
  req.authUser.privacy = normalizePrivacy(
    req.authUser.privacy?.toObject?.() || req.authUser.privacy || {},
    req.body || {},
  );
  await req.authUser.save();
  return res.json({ user: req.authUser.toJSON() });
};

const updateNotifications = async (req, res) => {
  req.authUser.notifications = normalizeNotifications(
    req.authUser.notifications?.toObject?.() ||
      req.authUser.notifications ||
      {},
    req.body || {},
  );
  await req.authUser.save();
  return res.json({ user: req.authUser.toJSON() });
};

const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword) {
    return res.status(400).json({ message: "New password is required" });
  }

  // First login: allow password change without current password
  if (
    req.authUser.isFirstLogin &&
    ["admin", "technician"].includes(req.authUser.role)
  ) {
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        message:
          "New password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
      });
    }
    req.authUser.passwordHash = await bcrypt.hash(String(newPassword), 10);
    req.authUser.isFirstLogin = false;
    await req.authUser.save();
    return res.json({
      message: "Password changed successfully. You may now log in.",
    });
  }

  // Normal password change
  if (!currentPassword) {
    return res
      .status(400)
      .json({ message: "Current password and new password are required" });
  }
  if (!req.authUser.passwordHash) {
    return res
      .status(400)
      .json({
        message:
          "This account uses OAuth. Set a local password from account recovery flow.",
      });
  }
  const valid = await bcrypt.compare(
    String(currentPassword),
    req.authUser.passwordHash,
  );
  if (!valid) {
    return res.status(400).json({ message: "Current password is incorrect" });
  }
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      message:
        "New password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
    });
  }
  if (String(currentPassword) === String(newPassword)) {
    return res
      .status(400)
      .json({
        message: "New password must be different from current password",
      });
  }
  req.authUser.passwordHash = await bcrypt.hash(String(newPassword), 10);
  await req.authUser.save();
  return res.json({ message: "Password changed successfully" });
};

const requestPasswordChangeEmail = async (req, res) => {
  if (!canSendEmail()) {
    return res
      .status(500)
      .json({ message: "Email service is not configured." });
  }

  const { token, tokenHash } = generatePasswordResetToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + PASSWORD_RESET_MINUTES * 60 * 1000,
  );

  req.authUser.passwordReset = {
    tokenHash,
    expiresAt,
    usedAt: null,
    requestedAt: now,
  };
  await req.authUser.save();

  const encodedToken = encodeURIComponent(token);
  const resetUrl = `${env.frontendUrl}/reset-password/${encodedToken}`;

  await sendEmail({
    to: req.authUser.email,
    subject: "Change your AeroPulse password",
    text: [
      "A request was made to change your AeroPulse password.",
      `Use this secure link to continue (valid for ${PASSWORD_RESET_MINUTES} minutes):`,
      resetUrl,
      "If you did not request this, you can ignore this email.",
    ].join("\n\n"),
    html: `
      <p>A request was made to change your AeroPulse password.</p>
      <p>Use this secure link to continue (valid for ${PASSWORD_RESET_MINUTES} minutes):</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  });

  return res.json({ message: "Password change link sent to your email." });
};

const anonymizeRelatedData = async (userId) => {
  const maskedName = "Deleted User";
  await Order.updateMany(
    { customer: userId },
    {
      $set: {
        customer: null,
        customerName: maskedName,
        "address.name": maskedName,
        "address.phone": "",
      },
    },
  );
  await Notification.deleteMany({ user: userId });
};

const deleteAccount = async (req, res) => {
  const { password, confirmText } = req.body || {};
  const confirmation = String(confirmText || "")
    .trim()
    .toUpperCase();
  if (confirmation !== "DELETE") {
    return res
      .status(400)
      .json({ message: "Please type DELETE to confirm account deletion." });
  }

  if (req.authUser.passwordHash) {
    if (!password) {
      return res
        .status(400)
        .json({ message: "Password is required to delete your account." });
    }
    const valid = await bcrypt.compare(
      String(password),
      req.authUser.passwordHash,
    );
    if (!valid) {
      return res.status(401).json({ message: "Incorrect password." });
    }
  }

  const mode =
    String(env.accountDeleteMode || "soft").toLowerCase() === "hard"
      ? "hard"
      : "soft";
  const userId = req.authUser._id;

  if (mode === "hard") {
    await anonymizeRelatedData(userId);
    await req.authUser.deleteOne();
    return res.json({ message: "Account deleted successfully", mode });
  }

  const deletedAlias = `deleted_${String(userId)}@deleted.local`;
  req.authUser.email = deletedAlias;
  req.authUser.username = undefined;
  req.authUser.name = "Deleted User";
  req.authUser.name_first = "Deleted";
  req.authUser.name_last = "User";
  req.authUser.phone = undefined;
  req.authUser.passwordHash = "";
  req.authUser.avatarUrl = "";
  req.authUser.address = "";
  req.authUser.billingAddress = {
    region: "",
    province: "",
    city: "",
    barangay: "",
    street: "",
  };
  req.authUser.addresses = [];
  req.authUser.privacy = normalizePrivacy(
    req.authUser.privacy?.toObject?.() || {},
    {
      profileVisibility: "private",
      showEmail: false,
      showPhone: false,
      activityStatus: false,
      dataSharing: false,
    },
  );
  req.authUser.notifications = normalizeNotifications(
    req.authUser.notifications?.toObject?.() || {},
    {
      email: false,
      inApp: false,
      push: false,
      sms: false,
      accountUpdates: false,
      orderUpdates: false,
      systemAlerts: false,
      promotions: false,
      serviceUpdates: false,
    },
  );
  req.authUser.accountStatus = "deleted";
  req.authUser.isDeleted = true;
  req.authUser.deletedAt = new Date();

  await req.authUser.save();
  await anonymizeRelatedData(userId);
  return res.json({ message: "Account deleted successfully", mode });
};

const deleteUserById = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target || target.isDeleted || target.accountStatus === "deleted") {
    return res.status(404).json({ message: "User not found" });
  }

  if (!canManageTargetProfile(req.authUser, target)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const mode =
    String(env.accountDeleteMode || "soft").toLowerCase() === "hard"
      ? "hard"
      : "soft";
  const userId = target._id;

  if (mode === "hard") {
    await anonymizeRelatedData(userId);
    await target.deleteOne();
    return res.json({ message: "Account deleted successfully", mode });
  }

  const deletedAlias = `deleted_${String(userId)}@deleted.local`;
  target.email = deletedAlias;
  target.username = undefined;
  target.name = "Deleted User";
  target.name_first = "Deleted";
  target.name_last = "User";
  target.phone = undefined;
  target.passwordHash = "";
  target.avatarUrl = "";
  target.address = "";
  target.billingAddress = {
    region: "",
    province: "",
    city: "",
    barangay: "",
    street: "",
  };
  target.addresses = [];
  target.privacy = normalizePrivacy(target.privacy?.toObject?.() || {}, {
    profileVisibility: "private",
    showEmail: false,
    showPhone: false,
    activityStatus: false,
    dataSharing: false,
  });
  target.notifications = normalizeNotifications(
    target.notifications?.toObject?.() || {},
    {
      email: false,
      inApp: false,
      push: false,
      sms: false,
      accountUpdates: false,
      orderUpdates: false,
      systemAlerts: false,
      promotions: false,
      serviceUpdates: false,
    },
  );
  target.accountStatus = "deleted";
  target.isDeleted = true;
  target.deletedAt = new Date();

  await target.save();
  await anonymizeRelatedData(userId);
  return res.json({ message: "Account deleted successfully", mode });
};

const listUsers = async (req, res) => {
  const role = String(req.query.role || "").trim();
  const locked = req.query.locked;

  const query = { isDeleted: { $ne: true }, accountStatus: { $ne: "deleted" } };
  if (role) query.role = role;
  if (locked === "true") query.lockoutUntil = { $gt: new Date() };

  // Admin can only list customers and technicians.
  if (req.authUser.role === "admin") {
    query.role = role || { $in: ["customer", "technician"] };
    if (role && !["customer", "technician"].includes(role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
  }

  const users = await User.find(query).sort({ createdAt: -1 }).limit(500);
  return res.json({ users: users.map((u) => u.toJSON()) });
};

const unlockUser = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user || user.isDeleted || user.accountStatus === "deleted") {
    return res.status(404).json({ message: "User not found" });
  }

  if (!canManageTargetProfile(req.authUser, user)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  user.failedLoginAttempts = 0;
  user.lockoutUntil = null;
  await user.save();
  await notifyOperationalStaff({
    title: "User account unlocked",
    message: `${user.name || user.email || "A user"} was unlocked by ${req.authUser.name || req.authUser.email || "an administrator"}.`,
    type: "security",
    category: "account_access",
    severity: "warning",
    targetId: String(user._id),
    targetType: "user",
    dedupeKey: `user-unlocked:${user._id}:${Date.now()}`,
    roles: ["superadmin"],
  });
  return res.json({ user: user.toJSON() });
};

const updateUserStatus = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user || user.isDeleted || user.accountStatus === "deleted") {
    return res.status(404).json({ message: "User not found" });
  }

  if (!canManageTargetProfile(req.authUser, user)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const nextStatus = String(req.body?.status || "")
    .trim()
    .toLowerCase();
  if (!nextStatus || !["active", "disabled"].includes(nextStatus)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  user.accountStatus = nextStatus;
  await user.save();
  await notifyOperationalStaff({
    title: "User account status changed",
    message: `${user.name || user.email || "A user"} was ${nextStatus} by ${req.authUser.name || req.authUser.email || "an administrator"}.`,
    type: "security",
    category: "account_access",
    severity: nextStatus === "disabled" ? "warning" : "info",
    targetId: String(user._id),
    targetType: "user",
    dedupeKey: `user-status:${user._id}:${nextStatus}:${Date.now()}`,
    roles: ["superadmin"],
  });
  return res.json({ user: user.toJSON() });
};

const shouldCreateInAppNotification = (user, type = "system") => {
  if (!user) return false;
  const notifications =
    user.notifications?.toObject?.() || user.notifications || {};
  if (notifications.inApp === false || notifications.push === false)
    return false;
  if (!NOTIFICATION_TYPES.includes(type)) return true;
  if (type === "account" && notifications.accountUpdates === false)
    return false;
  if (type === "order" && notifications.orderUpdates === false) return false;
  if (type === "system" && notifications.systemAlerts === false) return false;
  return true;
};

const updateLocation = async (req, res) => {
  const location = req.body?.location;
  if (!location || typeof location !== "object") {
    return res.status(400).json({ message: "Location data is required" });
  }

  // Validate coordinates if provided
  if (location.coordinates) {
    const { latitude, longitude, accuracy } = location.coordinates;
    if (latitude !== null && (latitude < -90 || latitude > 90)) {
      return res
        .status(400)
        .json({
          message: "Invalid latitude. Must be between -90 and 90 degrees.",
        });
    }
    if (longitude !== null && (longitude < -180 || longitude > 180)) {
      return res
        .status(400)
        .json({
          message: "Invalid longitude. Must be between -180 and 180 degrees.",
        });
    }
    if (accuracy !== null && accuracy < 0) {
      return res
        .status(400)
        .json({ message: "Invalid accuracy. Must be non-negative." });
    }
  }

  // Normalize location data
  const normalizedLocation = {
    coordinates: location.coordinates
      ? {
          latitude: location.coordinates.latitude,
          longitude: location.coordinates.longitude,
          accuracy: location.coordinates.accuracy,
          timestamp: location.coordinates.timestamp || new Date().toISOString(),
        }
      : undefined,
    address: location.address
      ? {
          region: sanitizeText(location.address.region, 120),
          province: sanitizeText(location.address.province, 120),
          city: sanitizeText(location.address.city, 120),
          barangay: sanitizeText(location.address.barangay, 120),
          street: sanitizeText(location.address.street, 180),
          postalCode: sanitizeText(location.address.postalCode, 10),
        }
      : undefined,
    source: ["gps", "manual", "ip"].includes(location.source)
      ? location.source
      : "manual",
    capturedAt: new Date(),
  };

  // Remove undefined fields
  if (!normalizedLocation.coordinates) {
    delete normalizedLocation.coordinates;
  }
  if (!normalizedLocation.address) {
    delete normalizedLocation.address;
  }

  req.authUser.location = normalizedLocation;
  await req.authUser.save();

  return res.json({
    message: "Location updated successfully",
    location: req.authUser.location,
  });
};

module.exports = {
  listUsers,
  getProfile,
  getProfileById,
  updateProfile,
  updateProfileById,
  updateLocation,
  listAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  updateSettings,
  updatePreferences,
  updatePrivacy,
  updateNotifications,
  changePassword,
  requestPasswordChangeEmail,
  deleteAccount,
  deleteUserById,
  unlockUser,
  updateUserStatus,
  shouldCreateInAppNotification,
};
