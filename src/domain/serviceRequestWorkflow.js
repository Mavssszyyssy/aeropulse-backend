const SERVICE_REQUEST_STATUSES = Object.freeze([
  "Pending",
  "Submitted",
  "Reviewed",
  "Assigned",
  "In Progress",
  "Completed",
  "Cancelled",
]);

const STATUS_LOOKUP = new Map(
  SERVICE_REQUEST_STATUSES.map((status) => [status.toLowerCase(), status]),
);

const TRANSITIONS = Object.freeze({
  Pending: ["Reviewed", "Assigned", "In Progress", "Cancelled"],
  Submitted: ["Reviewed", "Assigned", "In Progress", "Cancelled"],
  Reviewed: ["Assigned", "In Progress", "Cancelled"],
  Assigned: ["In Progress", "Cancelled"],
  "In Progress": ["Completed", "Cancelled"],
  Completed: [],
  Cancelled: [],
});

const normalizeServiceRequestStatus = (value, fallback = null) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized ? STATUS_LOOKUP.get(normalized) || null : fallback;
};

const canTransitionServiceRequest = (currentValue, nextValue) => {
  const current = normalizeServiceRequestStatus(currentValue, "Pending");
  const next = normalizeServiceRequestStatus(nextValue);
  if (!current || !next) return false;
  if (current === next) return true;
  return (TRANSITIONS[current] || []).includes(next);
};

const canCustomerCancelServiceRequest = (currentValue) =>
  ["Pending", "Submitted", "Reviewed", "Assigned"].includes(
    normalizeServiceRequestStatus(currentValue, "Pending"),
  );

module.exports = {
  SERVICE_REQUEST_STATUSES,
  normalizeServiceRequestStatus,
  canTransitionServiceRequest,
  canCustomerCancelServiceRequest,
};
