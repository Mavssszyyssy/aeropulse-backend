const { serviceTypeFor } = require("./serviceEvidence");

const normalize = (value) => String(value || "").trim().toLowerCase();
const textFor = (record = {}) => [
  record.issue,
  record.issueType,
  record.findings,
  record.actionTaken,
  ...(Array.isArray(record.serviceActions) ? record.serviceActions : []),
  ...(Array.isArray(record.partsUsed) ? record.partsUsed : []),
  record.technicianInputs?.notes,
  record.customerInputs?.reportedIssue,
  record.customerInputs?.notes,
  record.customerInputs?.other,
  record.payload?.serviceType,
  record.payload?.issueType,
  record.payload?.concern,
  record.payload?.issueDescription,
  record.payload?.notes,
  record.payload?.other,
  record.payload?.otherIssue,
  record.payload?.otherDescription,
].map(normalize).filter(Boolean).join(" ");

const SIGNALS = [
  {
    code: "filter_dirt",
    label: "dirty or dust-loaded air filter",
    matches: (text) => /(?:dust|dirty|clogged|blocked)[^.]*(?:air )?filter|(?:air )?filter[^.]*(?:dust|dirty|clogged|blocked)/i.test(text),
  },
  {
    code: "coil_dirt",
    label: "dirty evaporator coil",
    matches: (text) => /(?:dust|dirty|clogged|blocked)[^.]*(?:evaporator )?coil|(?:evaporator )?coil[^.]*(?:dust|dirty|clogged|blocked)/i.test(text),
  },
  {
    code: "deep_cleaning",
    label: "deep or disassembly cleaning",
    matches: (text, record) => serviceTypeFor(record) === "deep_cleaning" || /deep clean|disassembl[^.]*clean/i.test(text),
  },
  {
    code: "coil_maintenance",
    label: "evaporator coil cleaning",
    matches: (text) => /clean(?:ed|ing)?[^.]*(?:evaporator )?coil|(?:evaporator )?coil cleaning/i.test(text),
  },
  {
    code: "refrigerant_issue",
    label: "refrigerant-related issue",
    matches: (text) => /refrigerant|freon|coolant charge/i.test(text),
  },
];

const codesFor = (record) => {
  const text = textFor(record);
  return SIGNALS.filter((signal) => signal.matches(text, record)).map((signal) => signal.code);
};

const countCodes = (records = []) => {
  const counts = Object.fromEntries(SIGNALS.map((signal) => [signal.code, 0]));
  records.forEach((record) => {
    for (const code of new Set(codesFor(record))) counts[code] += 1;
  });
  return counts;
};

const frequencyFor = (records, dateField) => {
  const dates = [...new Set(records.map(record => new Date(record?.[dateField])).filter(date => Number.isFinite(date.getTime())).map(date => date.getTime()))].sort((a, b) => a - b);
  if (dates.length < 2) return { datedRecordCount: dates.length, averageGapDays: null };
  return { datedRecordCount: dates.length, averageGapDays: Math.round((dates.at(-1) - dates[0]) / 86400000 / (dates.length - 1)) };
};

function maintenanceSignalsFor(histories = [], serviceRequests = []) {
  const completed = histories.filter((history) => serviceTypeFor(history) !== "installation");
  const requests = serviceRequests.filter((request) => normalize(request.status) !== "cancelled");
  const historyCounts = countCodes(completed);
  const requestCounts = countCodes(requests);
  const completedServiceFrequency = frequencyFor(completed, "serviceDate");
  const serviceRequestFrequency = frequencyFor(requests, "createdAt");
  const recurringProblems = SIGNALS
    .filter((signal) => !["deep_cleaning", "coil_maintenance", "refrigerant_issue"].includes(signal.code))
    .map((signal) => ({
      code: signal.code,
      label: signal.label,
      count: Math.max(historyCounts[signal.code], requestCounts[signal.code]),
    }))
    .filter((signal) => signal.count >= 2);

  return {
    completedServiceCount: completed.length,
    cleaningRecordCount: completed.filter((history) => ["regular_cleaning", "deep_cleaning"].includes(serviceTypeFor(history))).length,
    repairRecordCount: completed.filter((history) => serviceTypeFor(history) === "repair").length,
    serviceRequestCount: requests.length,
    completedServiceFrequency,
    serviceRequestFrequency,
    filterDirtRecordCount: Math.max(historyCounts.filter_dirt, requestCounts.filter_dirt),
    coilDirtRecordCount: Math.max(historyCounts.coil_dirt, requestCounts.coil_dirt),
    deepCleaningRecordCount: historyCounts.deep_cleaning,
    coilMaintenanceRecordCount: historyCounts.coil_maintenance,
    refrigerantIssueRecordCount: Math.max(historyCounts.refrigerant_issue, requestCounts.refrigerant_issue),
    recurringProblems,
    refrigerantExcludedFromCleaningIntervals: true,
  };
}

module.exports = { maintenanceSignalsFor, codesFor };
