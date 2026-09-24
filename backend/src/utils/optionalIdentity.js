const OPTIONAL_IDENTITY_FIELDS = [
  "email",
  "emailIdentityKey",
  "phone",
  "alias",
  "username",
  "googleId",
];

const normalizeOptionalIdentity = (value) => {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};

const duplicateIdentityField = (error = {}) => {
  if (Number(error?.code) !== 11000) return "";
  const structuredField = Object.keys(
    error.keyPattern || error.keyValue || {},
  ).find((field) => OPTIONAL_IDENTITY_FIELDS.includes(field));
  if (structuredField) return structuredField === "emailIdentityKey" ? "email" : structuredField;

  const message = String(error?.message || "");
  const messageField = (
    OPTIONAL_IDENTITY_FIELDS.find(
      (field) =>
        message.includes(`${field}_1`) || message.includes(`${field}:`),
    ) || "unknown"
  );
  return messageField === "emailIdentityKey" ? "email" : messageField;
};

const duplicateIdentityMessage = (error = {}) => {
  const field = duplicateIdentityField(error);
  if (!field) return "";
  const messages = {
    email: "An account with this email address already exists.",
    phone: "An account with this mobile number already exists.",
    alias: "This sign-in alias is already in use.",
    username: "This username is already in use.",
    googleId: "This Google account is already connected to another user.",
    unknown: "One of these account details is already in use.",
  };
  return messages[field] || messages.unknown;
};

// Restrict friendly conflict handling to user-account write handlers.
const withIdentityConflict = (handler) => async (req, res, next) => {
  try {
    return await handler(req, res, next);
  } catch (error) {
    const message = duplicateIdentityMessage(error);
    if (message) return res.status(409).json({ message });
    throw error;
  }
};

module.exports = {
  withIdentityConflict,
  duplicateIdentityField,
  duplicateIdentityMessage,
  normalizeOptionalIdentity,
};
