const { serviceLabel, serviceTypeFor } = require("./serviceEvidence");

const FOLLOW_UP_DAYS = [7, 14, 30, 60, 90, 120, 180, 240, 270, 360];
const SEVERITIES = ["routine", "monitor", "soon", "urgent"];
const FOLLOW_UP_ACTIONS = ["routine_cleaning", "inspection", "repair_assessment"];
const REPAIR_GUIDANCE = ["not_indicated", "inspection_needed", "repair_may_be_needed", "replacement_may_be_needed"];
const DAY_OPTIONS_BY_SEVERITY = {
  routine: new Set([120, 180, 240, 270, 360]),
  monitor: new Set([60, 90, 120, 180]),
  soon: new Set([14, 30, 60]),
  urgent: new Set([7, 14, 30]),
};

const clean = (value, max = 700) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const dateValue = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};
const dateKey = (value) => dateValue(value)?.toISOString().slice(0, 10) || "";
const addDays = (value, days) => {
  const date = dateValue(value);
  if (!date) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + Number(days || 0)));
};
const list = (value) => (Array.isArray(value) ? value : String(value || "").split(","))
  .map((item) => clean(item, 180)).filter(Boolean);
const sentence = (value) => {
  const text = clean(value, 700);
  return text && !/[.!?]$/.test(text) ? `${text}.` : text;
};

const repairSignal = (text) => /repair|fix|damag|broken|break|worn|wear|noise|leak|weak cooling|not cooling|fault|crack|rust|corrod|loose|burn|overheat|sparking|replace/i.test(text);
const replacementSignal = (text) => /replace|replacement/i.test(text);
const urgentSignal = (text) => /urgent|danger|unsafe|smoke|burning|sparking|electrical|overheat|not working|failed|completely broken|severe|major leak|stop using/i.test(text);

function buildVisitEvidence({ unit = {}, serviceHistory = {}, priorHistory = [], recommendation = {} } = {}) {
  const findings = clean(serviceHistory.findings || serviceHistory.technicianInputs?.notes, 1000);
  const actions = clean(serviceHistory.actionTaken || list(serviceHistory.serviceActions).join(", "), 1000);
  const condition = clean(serviceHistory.conditionRating, 30).toLowerCase();
  const parts = list(serviceHistory.partsUsed).slice(0, 12);
  const facts = {
    latest_findings: findings,
    latest_work_performed: actions,
    latest_condition: condition ? `Technician condition rating: ${condition}.` : "",
    latest_parts: parts.length ? `Parts recorded by the technician: ${parts.join(", ")}.` : "",
    unit_profile: clean([unit.brand, unit.modelName || unit.model, unit.category, unit.capacityHp ? `${unit.capacityHp} HP` : ""].filter(Boolean).join(" · "), 300),
  };
  priorHistory.slice(0, 5).forEach((history, index) => {
    const previousFinding = clean(history.findings || history.technicianInputs?.notes, 500);
    const previousWork = clean(history.actionTaken || list(history.serviceActions).join(", "), 400);
    if (previousFinding) facts[`prior_visit_${index + 1}`] = `${dateKey(history.serviceDate) || "Earlier visit"} · ${serviceLabel(serviceTypeFor(history))}: ${previousFinding}${previousWork ? ` Work performed: ${previousWork}` : ""}`;
  });
  Object.keys(facts).forEach((key) => { if (!facts[key]) delete facts[key]; });
  const baselineDays = Math.round(Number(recommendation.historicalBasis?.intervalDays || recommendation.predictionEvidence?.baselineIntervalDays || 180));
  const normalizedBaseline = FOLLOW_UP_DAYS.reduce((best, option) => Math.abs(option - baselineDays) < Math.abs(best - baselineDays) ? option : best, 180);
  return {
    version: 1,
    visit: {
      service_date: dateKey(serviceHistory.serviceDate),
      service_type: serviceTypeFor(serviceHistory),
      condition,
      findings,
      work_performed: actions,
      parts_used: parts,
    },
    unit: {
      brand: clean(unit.brand, 80),
      model: clean(unit.modelName || unit.model, 120),
      category: clean(unit.category, 80),
      capacity_hp: Number(unit.capacityHp || 0) || null,
    },
    existing_schedule: {
      suggested_date: dateKey(recommendation.bestServicedBy),
      recommended_service: recommendation.recommendedService || "",
      baseline_interval_days: normalizedBaseline,
    },
    allowed_follow_up_days: FOLLOW_UP_DAYS,
    fact_catalog: facts,
  };
}

function validVisitAnalysis(raw, evidence = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const expected = ["evidence_fact_ids", "follow_up_action", "follow_up_days", "repair_or_replacement", "severity"];
  if (Object.keys(raw).sort().join("|") !== expected.join("|")) return false;
  if (!SEVERITIES.includes(raw.severity) || !FOLLOW_UP_ACTIONS.includes(raw.follow_up_action) || !REPAIR_GUIDANCE.includes(raw.repair_or_replacement)) return false;
  if (!evidence.allowed_follow_up_days?.includes(raw.follow_up_days) || !DAY_OPTIONS_BY_SEVERITY[raw.severity]?.has(raw.follow_up_days)) return false;
  if (!Array.isArray(raw.evidence_fact_ids) || raw.evidence_fact_ids.length < 1 || raw.evidence_fact_ids.length > 4) return false;
  const factIds = Object.keys(evidence.fact_catalog || {});
  if (new Set(raw.evidence_fact_ids).size !== raw.evidence_fact_ids.length || !raw.evidence_fact_ids.every((id) => factIds.includes(id))) return false;
  if (!raw.evidence_fact_ids.includes("latest_findings")) return false;
  const recordedFindings = evidence.visit?.findings || "";
  // Completed work (for example, "replaced the filter") is not evidence that
  // another replacement or repair is still required. Future-risk decisions
  // must be supported by the technician's findings themselves.
  if (raw.repair_or_replacement === "replacement_may_be_needed" && !replacementSignal(recordedFindings)) return false;
  if (raw.repair_or_replacement === "repair_may_be_needed" && !repairSignal(recordedFindings)) return false;
  if (raw.severity === "urgent" && !urgentSignal(recordedFindings)) return false;
  if (raw.follow_up_action === "repair_assessment" && !repairSignal(recordedFindings)) return false;
  return true;
}

const actionLabel = (action, defaultCleaning = "regular_cleaning") => {
  if (action === "repair_assessment") return "Repair assessment";
  if (action === "inspection") return "AC inspection";
  return serviceLabel(["regular_cleaning", "deep_cleaning"].includes(defaultCleaning) ? defaultCleaning : "regular_cleaning");
};

const guidanceFor = (value) => ({
  not_indicated: "The submitted report does not indicate that repair or replacement is needed.",
  inspection_needed: "A follow-up inspection is recommended before deciding whether any repair or replacement is needed.",
  repair_may_be_needed: "A repair assessment is recommended. The submitted report does not confirm a final repair until the unit is inspected again.",
  replacement_may_be_needed: "The submitted report mentions replacement. A qualified technician should confirm the required part or component before work is approved.",
  not_assessed: "Please review the technician's original report for the recorded condition and work performed.",
}[value] || "Please review the technician's original report for the recorded condition and work performed.");

function finalizeVisitAnalysis({ providerResult = {}, evidence = {}, recommendation = {}, serviceHistory = {} } = {}) {
  const ai = providerResult.provider === "openai" && validVisitAnalysis(providerResult.insight, evidence)
    ? providerResult.insight : null;
  const serviceDate = dateValue(serviceHistory.serviceDate) || new Date();
  const fallbackDate = dateValue(recommendation.bestServicedBy);
  const followUpDate = ai ? addDays(serviceDate, ai.follow_up_days) : fallbackDate;
  const recommendedService = ai?.follow_up_action === "repair_assessment" ? "repair"
    : ai?.follow_up_action === "inspection" ? "inspection"
      : recommendation.recommendedService || "regular_cleaning";
  const finding = clean(serviceHistory.findings || serviceHistory.technicianInputs?.notes, 700);
  const work = clean(serviceHistory.actionTaken || list(serviceHistory.serviceActions).join(", "), 700);
  const visitLabel = serviceLabel(serviceTypeFor(serviceHistory));
  const recorded = `During the completed ${visitLabel.toLowerCase()}, the technician recorded: ${sentence(finding)} Work completed: ${sentence(work)}`;
  const followUp = followUpDate
    ? `${actionLabel(ai?.follow_up_action, recommendation.recommendedService)} is recommended by ${dateKey(followUpDate)}.`
    : "A follow-up date could not be calculated from the available records.";
  const customerSummary = ai
    ? `${recorded} ${guidanceFor(ai.repair_or_replacement)} ${followUp}`
    : `${recorded} The automatic follow-up review is temporarily unavailable. ${followUp}`;
  const recommendedActions = [
    guidanceFor(ai?.repair_or_replacement || "not_assessed"),
    followUp,
  ];
  return {
    provider: ai ? "openai" : "system-fallback",
    status: ai ? "completed" : "unavailable",
    whatHappened: `${visitLabel}: ${work}`,
    problemsFound: finding,
    severity: ai?.severity || "not_assessed",
    repairOrReplacement: ai?.repair_or_replacement || "not_assessed",
    recommendedAction: ai?.follow_up_action || "existing_schedule",
    recommendedActions,
    recommendedService,
    recommendedFollowUpDays: ai?.follow_up_days || null,
    recommendedFollowUpDate: followUpDate,
    evidenceFactIds: ai?.evidence_fact_ids || ["latest_findings", "latest_work_performed"].filter((id) => evidence.fact_catalog?.[id]),
    customerSummary: clean(customerSummary, 1800),
    model: ai ? providerResult.model || "" : "",
    requestId: ai ? providerResult.requestId || "" : "",
    generatedAt: new Date(),
    warning: ai ? "" : clean(providerResult.error || "AI analysis was unavailable; the existing recorded schedule is shown.", 300),
  };
}

module.exports = {
  FOLLOW_UP_DAYS,
  buildVisitEvidence,
  finalizeVisitAnalysis,
  validVisitAnalysis,
};
