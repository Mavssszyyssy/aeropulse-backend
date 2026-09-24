const ADMIN_PROTECTED_KEYS = new Set([
  "activeBranch",
  "address",
  "adminMode",
  "assignedBranch",
  "branch",
  "branchAddress",
  "company",
  "companyName",
  "permissions",
  "role",
  "roles",
  "storeName",
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const containsProtectedAdminFields = (payload = {}) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if ([...ADMIN_PROTECTED_KEYS].some((key) => hasOwn(payload, key))) return true;

  const general = payload.general;
  if (general && typeof general === "object") {
    if (["address", "branch", "branchAddress", "companyName", "storeName"]
      .some((key) => hasOwn(general, key))) return true;
  }

  return false;
};

module.exports = { ADMIN_PROTECTED_KEYS, containsProtectedAdminFields };
