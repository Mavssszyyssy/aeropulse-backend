const { formatDateKeyInTimeZone } = require("../utils/dateTime");

const SERVICE_TYPES = ["regular_cleaning", "deep_cleaning", "repair", "inspection", "installation"];
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const clean = (value) => String(value || "").trim();
const serviceTypeFor = (history = {}) => {
  const explicit = normalize(history.serviceType);
  const visit = normalize(history.visitType);
  // Legacy schemas defaulted serviceType to cleaning even on installation/repair visits.
  if (["installation", "repair", "inspection"].includes(visit) && (!explicit || explicit === "regular_cleaning")) return visit;
  if (SERVICE_TYPES.includes(explicit)) return explicit;
  if (["installation", "repair", "inspection"].includes(visit)) return visit;
  const actions = `${history.actionTaken || ""} ${(history.serviceActions || []).join(" ")}`.toLowerCase();
  if (/deep clean|overhaul|disassembl/.test(actions)) return "deep_cleaning";
  if (/regular clean|cleaned|cleaning performed/.test(actions)) return "regular_cleaning";
  return "unknown";
};

const serviceLabel = (value) => ({
  regular_cleaning: "Regular cleaning", deep_cleaning: "Deep cleaning", repair: "Repair",
  inspection: "Inspection", installation: "Installation",
})[normalize(value)] || "Service type not recorded";

const NON_REPORT_TEXT = /^(?:(?:test|testing)(?: only| data)?|sample|(?:asdf|qwerty)+|lorem ipsum|unknown|nothing|nil|no issue|no issues|okay|ok)[.!?\s]*$/i;
const hasMeaningfulReportText = (value, minimumLength) => {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length < minimumLength || NON_REPORT_TEXT.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.some((word) => /\p{L}/u.test(word))) return false;
  if (new Set(words.map((word) => word.toLowerCase())).size === 1 && words.length > 1) return false;
  const compact = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (compact.length >= 4 && new Set(compact).size <= 2) return false;
  return true;
};

const isDetailedFinding = (value) => {
  const text = clean(value);
  return hasMeaningfulReportText(text, 10) && !/^(?:AMP recommended\b|service completed\.?$|no findings recorded\.?$|pending technician findings\.?$)/i.test(text);
};
const detailedActions = (value) => (Array.isArray(value) ? value : String(value || "").split(","))
  .map(clean).filter((item) => hasMeaningfulReportText(item, 3) && !/^(?:service completed|completed|done|n\/?a|none|not recorded)\.?$/i.test(item));

const assessServiceEvidence = (history = {}, { asOfDate = new Date(), installedAt } = {}) => {
  const serviceType = serviceTypeFor(history);
  const serviceDate = history.serviceDate ? new Date(history.serviceDate) : null;
  let reason = "";
  if (!serviceDate || !Number.isFinite(serviceDate.getTime())) reason = "Service date is missing or invalid.";
  else if (serviceDate > new Date(asOfDate)) reason = "Service date is in the future.";
  else if (installedAt && formatDateKeyInTimeZone(serviceDate) < formatDateKeyInTimeZone(installedAt)) reason = "Service date precedes the recorded installation.";
  else if (serviceType === "unknown") reason = "The service performed was not recorded.";
  else if (serviceType !== "installation" && (!isDetailedFinding(history.findings || history.technicianInputs?.notes) || !detailedActions(history.actionTaken || history.serviceActions).length)) reason = "Technician findings and actions are incomplete. This record is excluded from maintenance timing.";
  return { eligible: !reason, serviceType, serviceLabel: serviceLabel(serviceType), reason };
};

module.exports = { SERVICE_TYPES, serviceTypeFor, serviceLabel, hasMeaningfulReportText, isDetailedFinding, detailedActions, assessServiceEvidence };
