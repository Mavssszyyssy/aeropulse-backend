const LEGACY_DELETED_MESSAGE = "Message removed with deleted account.";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildOperationalContactFilter = ({ scope = {}, deletedCustomerIds = [], status = "", search = "" } = {}) => {
  const clauses = [
    { hiddenFromOperationalInbox: { $ne: true } },
    // Older soft deletions have a deleted User; hard deletions retain the
    // exact anonymization signature even after the User has been removed.
    { customer: { $nin: deletedCustomerIds } },
    { $nor: [{ customerName: "Deleted User", message: LEGACY_DELETED_MESSAGE, email: "", phone: "" }] },
  ];
  if (Object.keys(scope).length) clauses.push(scope);
  if (status) clauses.push({ status });
  const needle = String(search || "").trim().slice(0, 120);
  if (needle) {
    const pattern = new RegExp(escapeRegex(needle), "i");
    clauses.push({ $or: ["ticketCode", "customerName", "email", "phone", "subject", "message", "branch"]
      .map((field) => ({ [field]: pattern })) });
  }
  return { $and: clauses };
};

module.exports = { buildOperationalContactFilter, LEGACY_DELETED_MESSAGE };
