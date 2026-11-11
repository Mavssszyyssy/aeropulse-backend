const SERVICE_QUOTA_REQUIRED_MESSAGE =
  "A Service Quota is required before this technician can be assigned to a warranty claim.";
const MAX_SERVICE_QUOTA = 50;

const normalizeServiceQuota = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const quota = Number(value);
  return Number.isSafeInteger(quota) && quota >= 1 && quota <= MAX_SERVICE_QUOTA ? quota : null;
};

const requiresWarrantyServiceQuota = (request = {}) =>
  Boolean(String(request?.payload?.warrantyClaimId || request?.warrantyClaimId || "").trim());

const validateWarrantyAssignmentQuota = ({ request, technician } = {}) => {
  if (!requiresWarrantyServiceQuota(request)) return "";
  return normalizeServiceQuota(technician?.serviceQuota)
    ? ""
    : SERVICE_QUOTA_REQUIRED_MESSAGE;
};

module.exports = {
  MAX_SERVICE_QUOTA,
  SERVICE_QUOTA_REQUIRED_MESSAGE,
  normalizeServiceQuota,
  requiresWarrantyServiceQuota,
  validateWarrantyAssignmentQuota,
};
