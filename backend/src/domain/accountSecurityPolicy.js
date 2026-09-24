const TOTP_REQUIRED_ROLES = new Set([
  "customer",
  "technician",
  "admin",
  "superadmin",
]);

const normalizeRole = (role = "") => String(role).trim().toLowerCase().replace(/-/g, "_");

const roleRequiresTotp = (role) => TOTP_REQUIRED_ROLES.has(normalizeRole(role));

const requiresTotpEnrollment = (user = {}) =>
  roleRequiresTotp(user.role)
  && (!user.security?.totpEnabled || Boolean(user.security?.totpResetRequired));

module.exports = {
  TOTP_REQUIRED_ROLES,
  roleRequiresTotp,
  requiresTotpEnrollment,
};
