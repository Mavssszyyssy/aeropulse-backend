const { serviceLabel, serviceTypeFor } = require("./serviceEvidence");

const FOLLOW_UP_RANGE = { critical: [1, 3], urgent: [3, 7], soon: [8, 30], monitor: [31, 90], routine: [91, 365] };
const SEVERITIES = ["routine", "monitor", "soon", "urgent", "critical"];
const FOLLOW_UP_ACTIONS = ["routine_cleaning", "inspection", "repair_assessment"];
const REPAIR_GUIDANCE = ["not_indicated", "inspection_needed", "repair_may_be_needed", "replacement_may_be_needed"];
const RISK_TYPES = ["no_problem_indicated", "component_deterioration", "performance_decline", "leak_or_drainage", "electrical_or_safety", "other_recorded_risk"];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];

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

const concernText = (text) => String(text || "")
  .replace(/\bno\s+signs?\s+of\s+(?:[a-z0-9/-]+\s+){0,6}(?:faults?|failures?|malfunctions?|damage|wear)(?:\s+(?:or|and)\s+(?:unusual\s+)?(?:noise|leaks?|leaking|damage|wear|faults?|failures?|malfunctions?|problems?|issues?|sparking|smoke|burning|overheating))*\b/gi, "")
  .replace(/\bno\s+(?:signs?\s+of\s+)?(?:unusual\s+)?(?:noise|leaks?|leaking|damage|wear|faults?|failures?|malfunctions?|problems?|issues?|sparking|smoke|burning|overheating|repair|replacement)(?:\s+(?:or|and)\s+(?:unusual\s+)?(?:noise|leaks?|leaking|damage|wear|faults?|failures?|malfunctions?|problems?|issues?|sparking|smoke|burning|overheating|repair|replacement))*\b/gi, "")
  .replace(/\b(?:is|was|were|does|did)?\s*not\s+(?:showing\s+)?(?:making\s+)?(?:leaking|damaged|worn|noisy|failing|malfunctioning|sparking|smoking|burning|overheating)\b/gi, "")
  .replace(/\bwithout\s+(?:any\s+)?(?:unusual\s+)?(?:noise|leaks?|leaking|damage|wear|faults?|failures?|malfunctions?|problems?|issues?|sparking|smoke|burning|overheating)\b/gi, "");
const repairSignal = (text) => /repair|fix|damag|broken|break|worn|wear|noise|vibrat|leak|weak cooling|not cooling|fault|fail|malfunction|intermittent|not respond|error code|crack|rust|corrod|loose|burn|overheat|sparking|replace/i.test(concernText(text));
const replacementSignal = (text) => /replace|replacement/i.test(concernText(text));
const criticalSignal = (text) => /danger|unsafe|smoke|burning|sparking|electrical fire|fire risk|stop using/i.test(concernText(text));
const urgentSignal = (text) => /urgent|overheat|not working|fail(?:ed|ing|ure)?|completely broken|severe|major leak/i.test(concernText(text)) || criticalSignal(text);
const riskSupported = (riskType, text) => ({
  no_problem_indicated: !repairSignal(text),
  component_deterioration: /damag|broken|break|worn|wear|crack|rust|corrod|loose|noise|vibrat|fault|fail|malfunction|intermittent|not respond|error code|replace/i.test(concernText(text)),
  performance_decline: /weak cooling|not cooling|poor cooling|slow cooling|reduced cooling|performance/i.test(concernText(text)),
  leak_or_drainage: /leak|drain|drainage|water/i.test(concernText(text)),
  electrical_or_safety: /electrical|wiring|wire|capacitor|breaker|sparking|smoke|burning|unsafe|fire risk|stop using/i.test(concernText(text)),
  other_recorded_risk: repairSignal(text) || /condition:\s*(?:fair|poor)/i.test(text),
}[riskType] === true);

const COMPONENT_PATTERNS = [
  ["fan_motor", /fan motor/i],
  ["fan_or_blower", /\bfan\b|blower/i],
  ["compressor", /compressor/i],
  ["air_filter", /filter/i],
  ["evaporator_or_condenser_coil", /evaporator|condenser|\bcoil\b/i],
  ["drain_system", /drain|drainage/i],
  ["refrigerant_system", /refrigerant|freon/i],
  ["control_board", /control board|circuit board|main board|motherboard|controller board|inverter board|electronic board|\bpcb\b|pcb module/i],
  ["electrical_system", /electrical|wiring|wire|capacitor|breaker|sparking/i],
  ["thermostat_or_sensor", /thermostat|sensor/i],
  ["casing_or_mount", /casing|housing|mount|bracket/i],
];
const componentCandidates = (findings) => [...new Set([
  ...COMPONENT_PATTERNS.filter(([, pattern]) => pattern.test(findings)).map(([component]) => component),
  "not_specified",
])];

function buildVisitEvidence({ unit = {}, serviceHistory = {}, priorHistory = [], recommendation = {} } = {}) {
  const findings = clean(serviceHistory.findings, 1000);
  const technicianNotes = clean(serviceHistory.technicianInputs?.notes, 1000);
  const actions = clean(serviceHistory.actionTaken || list(serviceHistory.serviceActions).join(", "), 1000);
  const condition = clean(serviceHistory.conditionRating, 30).toLowerCase();
  const parts = list(serviceHistory.partsUsed).slice(0, 12);
  const customerIssue = clean(serviceHistory.customerInputs?.reportedIssue, 1000);
  const customerNotes = clean(serviceHistory.customerInputs?.notes, 1000);
  const customerOther = clean(serviceHistory.customerInputs?.other, 1000);
  const distinctNotes = technicianNotes && technicianNotes.toLowerCase() !== findings.toLowerCase()
    ? technicianNotes : "";
  const currentObservations = clean([
    findings ? `Findings: ${findings}` : "",
    distinctNotes ? `Additional technician notes: ${distinctNotes}` : "",
    customerIssue ? `Customer-reported concern: ${customerIssue}` : "",
    customerNotes ? `Customer notes: ${customerNotes}` : "",
    customerOther ? `Customer custom observation: ${customerOther}` : "",
    condition ? `Condition: ${condition}` : "",
    parts.length ? `Parts recorded: ${parts.join(", ")}` : "",
  ].filter(Boolean).join(" "), 2400);
  const concernEvidence = clean([
    findings,
    distinctNotes,
    customerIssue ? `Customer-reported concern: ${customerIssue}` : "",
    customerNotes ? `Customer notes: ${customerNotes}` : "",
    customerOther ? `Customer custom observation: ${customerOther}` : "",
    condition ? `Condition: ${condition}` : "",
  ].filter(Boolean).join(" "), 2200);
  const facts = {
    latest_observations: currentObservations,
    latest_findings: findings,
    latest_technician_notes: distinctNotes,
    latest_work_performed: actions,
    latest_condition: condition ? `Technician condition rating: ${condition}.` : "",
    latest_parts: parts.length ? `Parts recorded by the technician: ${parts.join(", ")}.` : "",
    customer_reported_issue: customerIssue ? `Customer-reported concern: ${customerIssue}` : "",
    customer_notes: customerNotes ? `Customer notes: ${customerNotes}` : "",
    customer_other_observation: customerOther ? `Customer custom observation: ${customerOther}` : "",
    unit_profile: clean([unit.brand, unit.modelName || unit.model, unit.category, unit.capacityHp ? `${unit.capacityHp} HP` : ""].filter(Boolean).join(" · "), 300),
  };
  priorHistory.slice(0, 5).forEach((history, index) => {
    const previousFinding = clean(history.findings, 500);
    const previousNotes = clean(history.technicianInputs?.notes, 400);
    const previousWork = clean(history.actionTaken || list(history.serviceActions).join(", "), 400);
    const previousParts = list(history.partsUsed).slice(0, 8);
    const previousDetail = [
      previousFinding,
      previousNotes && previousNotes.toLowerCase() !== previousFinding.toLowerCase() ? `Notes: ${previousNotes}` : "",
      previousParts.length ? `Parts: ${previousParts.join(", ")}` : "",
    ].filter(Boolean).join(" ");
    if (previousDetail) facts[`prior_visit_${index + 1}`] = `${dateKey(history.serviceDate) || "Earlier visit"} · ${serviceLabel(serviceTypeFor(history))}: ${previousDetail}${previousWork ? ` Work performed: ${previousWork}` : ""}`;
  });
  Object.keys(facts).forEach((key) => { if (!facts[key]) delete facts[key]; });
  const baselineDays = Math.min(365, Math.max(91, Math.round(Number(recommendation.historicalBasis?.intervalDays || recommendation.predictionEvidence?.baselineIntervalDays || 180))));
  return {
    version: 3,
    visit: {
      service_date: dateKey(serviceHistory.serviceDate),
      service_type: serviceTypeFor(serviceHistory),
      condition,
      findings,
      technician_notes: distinctNotes,
      observation_text: concernEvidence,
      work_performed: actions,
      parts_used: parts,
      customer_reported_issue: customerIssue,
      customer_notes: customerNotes,
      customer_other_observation: customerOther,
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
      baseline_interval_days: baselineDays,
    },
    follow_up_policy: {
      minimum_days: 1,
      maximum_days: 365,
      severity_ranges_days: FOLLOW_UP_RANGE,
      instruction: "Choose an exact evidence-based day count within the selected severity range. Use the routine baseline only when no condition-based concern is indicated.",
    },
    allowed_affected_components: componentCandidates(`${concernEvidence} ${parts.join(" ")}`),
    fact_catalog: facts,
  };
}

function validVisitAnalysis(raw, evidence = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const expected = ["affected_component", "evidence_confidence", "evidence_fact_ids", "follow_up_action", "follow_up_days", "repair_or_replacement", "risk_type", "severity"];
  if (Object.keys(raw).sort().join("|") !== expected.join("|")) return false;
  if (!SEVERITIES.includes(raw.severity) || !FOLLOW_UP_ACTIONS.includes(raw.follow_up_action) || !REPAIR_GUIDANCE.includes(raw.repair_or_replacement)) return false;
  if (!RISK_TYPES.includes(raw.risk_type) || !CONFIDENCE_LEVELS.includes(raw.evidence_confidence)) return false;
  if (!evidence.allowed_affected_components?.includes(raw.affected_component)) return false;
  const range = FOLLOW_UP_RANGE[raw.severity];
  if (!Number.isInteger(raw.follow_up_days) || !range || raw.follow_up_days < range[0] || raw.follow_up_days > range[1]) return false;
  if (!Array.isArray(raw.evidence_fact_ids) || raw.evidence_fact_ids.length < 1 || raw.evidence_fact_ids.length > 4) return false;
  const factIds = Object.keys(evidence.fact_catalog || {});
  if (new Set(raw.evidence_fact_ids).size !== raw.evidence_fact_ids.length || !raw.evidence_fact_ids.every((id) => factIds.includes(id))) return false;
  if (!raw.evidence_fact_ids.includes("latest_observations")) return false;
  const recordedFindings = evidence.visit?.observation_text || evidence.visit?.findings || "";
  // Completed work (for example, "replaced the filter") is not evidence that
  // another replacement or repair is still required. Future-risk decisions
  // must be supported by the technician's findings themselves.
  if (raw.repair_or_replacement === "replacement_may_be_needed" && !replacementSignal(recordedFindings)) return false;
  if (raw.repair_or_replacement === "repair_may_be_needed" && !repairSignal(recordedFindings)) return false;
  if (raw.severity === "urgent" && !urgentSignal(recordedFindings)) return false;
  if (raw.severity === "critical" && !criticalSignal(recordedFindings)) return false;
  if (raw.follow_up_action === "repair_assessment" && !repairSignal(recordedFindings)) return false;
  if (raw.risk_type === "no_problem_indicated" && (repairSignal(recordedFindings) || /condition:\s*(?:fair|poor)/i.test(recordedFindings) || raw.severity !== "routine" || raw.follow_up_action !== "routine_cleaning" || raw.repair_or_replacement !== "not_indicated" || raw.affected_component !== "not_specified")) return false;
  if (raw.risk_type === "no_problem_indicated" && raw.follow_up_days !== evidence.existing_schedule?.baseline_interval_days) return false;
  if (raw.risk_type !== "no_problem_indicated" && raw.severity === "routine") return false;
  if (!riskSupported(raw.risk_type, recordedFindings)) return false;
  if (raw.evidence_confidence === "high" && raw.affected_component === "not_specified" && raw.risk_type !== "no_problem_indicated") return false;
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

const serviceActionsFor = ({ ai, componentLabel, followUp }) => {
  if (!ai) return [guidanceFor("not_assessed"), followUp];
  if (ai.risk_type === "no_problem_indicated") {
    return [
      "Continue routine operation and monitor the AC for any new noise, leak, weak cooling, or other change.",
      followUp,
    ];
  }
  const subject = ai.affected_component === "not_specified"
    ? "the symptom recorded in the technician's report"
    : `the recorded ${componentLabel} concern`;
  const actions = [
    `Arrange a qualified technician assessment of ${subject}; confirm the cause before approving repair or replacement work.`,
  ];
  if (ai.repair_or_replacement === "replacement_may_be_needed") {
    actions.push(`Confirm the exact ${ai.affected_component === "not_specified" ? "component" : componentLabel} specification and stock availability before replacement is approved.`);
  } else if (ai.repair_or_replacement === "repair_may_be_needed") {
    actions.push(`Request a written repair scope and parts requirement for ${subject} after inspection.`);
  } else {
    actions.push(`Keep the original technician log available so ${subject} can be verified during the follow-up.`);
  }
  if (ai.risk_type === "electrical_or_safety" && ["critical", "urgent"].includes(ai.severity)) {
    actions.push("If the recorded electrical or safety symptom returns, stop using the unit and contact the service team promptly.");
  }
  actions.push(followUp);
  return actions;
};

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
  const technicianNotes = clean(serviceHistory.technicianInputs?.notes, 700);
  const distinctNotes = technicianNotes && technicianNotes.toLowerCase() !== finding.toLowerCase()
    ? technicianNotes : "";
  const parts = list(serviceHistory.partsUsed).slice(0, 12);
  const work = clean(serviceHistory.actionTaken || list(serviceHistory.serviceActions).join(", "), 700);
  const customerIssue = clean(serviceHistory.customerInputs?.reportedIssue, 700);
  const customerNotes = clean(serviceHistory.customerInputs?.notes, 700);
  const customerOther = clean(serviceHistory.customerInputs?.other, 700);
  const visitLabel = serviceLabel(serviceTypeFor(serviceHistory));
  const recorded = `During the completed ${visitLabel.toLowerCase()}, the technician recorded: ${sentence(finding)}${distinctNotes ? ` Additional notes: ${sentence(distinctNotes)}` : ""}${parts.length ? ` Parts recorded: ${sentence(parts.join(", "))}` : ""} Work completed: ${sentence(work)}`;
  const customerContext = [customerIssue, customerNotes, customerOther].filter(Boolean);
  const recordedContext = customerContext.length
    ? `${recorded} Customer observations considered: ${customerContext.map(sentence).join(" ")}`
    : recorded;
  const componentLabels = { fan_motor: "fan motor", fan_or_blower: "fan or blower", compressor: "compressor", air_filter: "air filter", evaporator_or_condenser_coil: "evaporator or condenser coil", drain_system: "drain system", refrigerant_system: "refrigerant system", control_board: "control board", electrical_system: "electrical system", thermostat_or_sensor: "thermostat or sensor", casing_or_mount: "casing or mounting", not_specified: "component not specified" };
  const riskLabels = { no_problem_indicated: "No developing problem is indicated in the submitted report", component_deterioration: "The report indicates a possible developing component-wear risk", performance_decline: "The report indicates a possible decline in AC performance", leak_or_drainage: "The report indicates a possible leak or drainage risk", electrical_or_safety: "The report indicates a possible electrical or safety risk", other_recorded_risk: "The report indicates another concern that should be monitored" };
  const affectedComponent = ai?.affected_component || "not_specified";
  const predictedRisk = ai ? `${riskLabels[ai.risk_type] || riskLabels.other_recorded_risk}${affectedComponent !== "not_specified" ? ` involving the ${componentLabels[affectedComponent]}` : ""}.` : "No AI risk interpretation is available.";
  const followUp = followUpDate
    ? `${actionLabel(ai?.follow_up_action, recommendation.recommendedService)} is recommended by ${dateKey(followUpDate)}.`
    : "A follow-up date could not be calculated from the available records.";
  const aiAssessment = ai
    ? `${recordedContext} ${predictedRisk} ${guidanceFor(ai.repair_or_replacement)}`
    : `${recordedContext} The automatic review is temporarily unavailable, so no new issue has been added by the system.`;
  const whyThisDate = followUpDate
    ? `${dateKey(followUpDate)} was selected because ${({ routine: "the report supports routine care", monitor: "the recorded concern should be watched", soon: "the recorded concern should be checked soon", urgent: "the recorded concern needs prompt attention", critical: "the recorded concern needs immediate attention" })[ai?.severity] || "the existing recorded schedule is being kept"}. The timing uses the technician's completed report and the service history available for this AC.`
    : "A date could not be selected from the available records.";
  const recommendedActions = serviceActionsFor({
    ai,
    componentLabel: componentLabels[affectedComponent] || "component",
    followUp,
  });
  const customerSummary = ai
    ? `${aiAssessment} Recommended next step: ${recommendedActions[0]} ${followUp}`
    : `${recordedContext} The automatic follow-up review is temporarily unavailable. ${followUp}`;
  return {
    analysisVersion: 4,
    provider: ai ? "openai" : "system-fallback",
    status: ai ? "completed" : "unavailable",
    whatHappened: `${visitLabel}: ${work}`,
    problemsFound: [finding, distinctNotes].filter(Boolean).join(" "),
    severity: ai?.severity || "not_assessed",
    riskType: ai?.risk_type || "not_assessed",
    predictedRisk,
    affectedComponent,
    evidenceConfidence: ai?.evidence_confidence || "not_assessed",
    recommendationMode: ai ? (ai.risk_type === "no_problem_indicated" ? "routine" : "condition_based") : "fallback",
    repairOrReplacement: ai?.repair_or_replacement || "not_assessed",
    recommendedAction: ai?.follow_up_action || "existing_schedule",
    recommendedActions,
    recommendedService,
    recommendedFollowUpDays: ai?.follow_up_days || null,
    recommendedFollowUpDate: followUpDate,
    evidenceFactIds: ai?.evidence_fact_ids || ["latest_observations", "latest_work_performed"].filter((id) => evidence.fact_catalog?.[id]),
    aiAssessment: clean(aiAssessment, 1800),
    whyThisDate: clean(whyThisDate, 1000),
    customerSummary: clean(customerSummary, 1800),
    model: ai ? providerResult.model || "" : "",
    requestId: ai ? providerResult.requestId || "" : "",
    generatedAt: new Date(),
    warning: ai ? "" : clean(providerResult.error || "AI analysis was unavailable; the existing recorded schedule is shown.", 300),
  };
}

module.exports = {
  FOLLOW_UP_RANGE,
  buildVisitEvidence,
  finalizeVisitAnalysis,
  validVisitAnalysis,
};
