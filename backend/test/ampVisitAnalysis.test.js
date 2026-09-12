const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("../src/config/env");
const Unit = require("../src/models/Unit");
const ServiceHistory = require("../src/models/ServiceHistory");
const { callStructuredAmpAnalysis } = require("../src/services/openAiAmpService");
const { buildVisitEvidence, finalizeVisitAnalysis, validVisitAnalysis } = require("../src/domain/ampVisitAnalysis");
const { analyzeCompletedVisit } = require("../src/domain/serviceCompletionService");

const service = {
  _id: "visit-1",
  serviceDate: "2026-09-12T02:00:00.000Z",
  serviceType: "regular_cleaning",
  conditionRating: "good",
  findings: "The fan motor made an unusual noise and appeared worn, while cooling remained normal.",
  actionTaken: "Cleaned the filter and tested cooling after service.",
  partsUsed: [],
};
const recommendation = {
  bestServicedBy: "2027-03-12T00:00:00.000Z",
  recommendedService: "regular_cleaning",
  historicalBasis: { intervalDays: 180 },
};

test("visit evidence keeps technician facts separate and excludes customer identity", () => {
  const evidence = buildVisitEvidence({ unit: { brand: "LG", modelName: "Dual Inverter", category: "split", capacityHp: 1.5, customer: "private-customer" }, serviceHistory: service, recommendation, priorHistory: [{ serviceDate: "2026-03-01", serviceType: "inspection", findings: "Filter had visible dust.", actionTaken: "Recorded the filter condition." }] });
  assert.equal(evidence.visit.findings, service.findings);
  assert.equal(evidence.fact_catalog.latest_work_performed, service.actionTaken);
  assert.equal(evidence.existing_schedule.baseline_interval_days, 180);
  assert.equal(evidence.unit.model, "Dual Inverter");
  assert.match(evidence.fact_catalog.prior_visit_1, /Inspection.*Filter had visible dust.*Recorded the filter condition/);
  assert.equal(JSON.stringify(evidence).includes("private-customer"), false);
});

test("visit analysis rejects unsupported replacement and urgent claims", () => {
  const evidence = buildVisitEvidence({ serviceHistory: service, recommendation });
  const base = { severity: "soon", follow_up_action: "repair_assessment", follow_up_days: 30, repair_or_replacement: "repair_may_be_needed", evidence_fact_ids: ["latest_findings"] };
  assert.equal(validVisitAnalysis(base, evidence), true);
  assert.equal(validVisitAnalysis({ ...base, repair_or_replacement: "replacement_may_be_needed" }, evidence), false);
  assert.equal(validVisitAnalysis({ ...base, severity: "urgent", follow_up_days: 7 }, evidence), false);
});

test("completed repair work alone cannot be turned into a future repair claim", () => {
  const repaired = { ...service, findings: "The filter was dirty before cleaning.", actionTaken: "Replaced the filter and tested cooling." };
  const evidence = buildVisitEvidence({ serviceHistory: repaired, recommendation });
  assert.equal(validVisitAnalysis({ severity: "soon", follow_up_action: "repair_assessment", follow_up_days: 30, repair_or_replacement: "repair_may_be_needed", evidence_fact_ids: ["latest_findings"] }, evidence), false);
  assert.equal(validVisitAnalysis({ severity: "soon", follow_up_action: "inspection", follow_up_days: 30, repair_or_replacement: "replacement_may_be_needed", evidence_fact_ids: ["latest_findings"] }, evidence), false);
});

test("customer visit summary uses the original log and stores contextual follow-up", () => {
  const evidence = buildVisitEvidence({ serviceHistory: service, recommendation });
  const result = finalizeVisitAnalysis({
    serviceHistory: service, recommendation, evidence,
    providerResult: { provider: "openai", model: "test-model", requestId: "request-1", insight: { severity: "soon", follow_up_action: "repair_assessment", follow_up_days: 30, repair_or_replacement: "repair_may_be_needed", evidence_fact_ids: ["latest_findings", "latest_work_performed"] } },
  });
  assert.equal(result.provider, "openai");
  assert.equal(result.recommendedService, "repair");
  assert.equal(new Date(result.recommendedFollowUpDate).toISOString().slice(0, 10), "2026-10-12");
  assert.match(result.customerSummary, /fan motor made an unusual noise/);
  assert.match(result.customerSummary, /Cleaned the filter and tested cooling/);
  assert.equal(result.recommendedActions.length, 2);
  assert.match(result.recommendedActions[1], /2026-10-12/);
});

test("fallback preserves the existing schedule without inventing a diagnosis", () => {
  const evidence = buildVisitEvidence({ serviceHistory: service, recommendation });
  const result = finalizeVisitAnalysis({
    serviceHistory: service, recommendation, evidence,
    providerResult: { provider: "system-fallback", error: "Provider unavailable" },
  });
  assert.equal(result.provider, "system-fallback");
  assert.equal(result.recommendedService, "regular_cleaning");
  assert.equal(new Date(result.recommendedFollowUpDate).toISOString().slice(0, 10), "2027-03-12");
  assert.match(result.customerSummary, /automatic follow-up review is temporarily unavailable/);
  assert.doesNotMatch(result.customerSummary, /follow-up inspection is recommended/i);
});

test("existing AI service sends structured technician visit analysis", async () => {
  const originalKey = env.openAiApiKey;
  const originalFetch = global.fetch;
  let requestBody;
  env.openAiApiKey = "test-visit-key";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, headers: { get: () => "visit-request" }, text: async () => JSON.stringify({ output_text: JSON.stringify({ severity: "monitor", follow_up_action: "inspection", follow_up_days: 60, repair_or_replacement: "inspection_needed", evidence_fact_ids: ["latest_findings"] }) }) };
  };
  try {
    const visitEvidence = buildVisitEvidence({ serviceHistory: { ...service, findings: `${service.findings} Test ${Date.now()}` }, recommendation });
    const result = await callStructuredAmpAnalysis({ visitAnalysis: true, visitEvidence, recommendation, safetyIdentifier: "technician-1" });
    assert.equal(result.provider, "openai");
    assert.equal(requestBody.text.format.name, "amp_visit_follow_up");
    assert.equal(requestBody.store, false);
    assert.deepEqual(result.insight.evidence_fact_ids, ["latest_findings"]);
  } finally {
    env.openAiApiKey = originalKey;
    global.fetch = originalFetch;
  }
});

test("completed visit analysis is stored separately and updates the shared unit schedule", async (t) => {
  const saved = { ...service, _id: "visit-1", aiInterpretation: {}, saveCalls: 0, async save() { this.saveCalls += 1; } };
  const chain = { sort() { return this; }, limit() { return this; }, lean: async () => [] };
  let unitUpdate;
  t.mock.method(ServiceHistory, "find", () => chain);
  t.mock.method(Unit, "updateOne", async (_query, update) => { unitUpdate = update.$set["amp.visitFollowUp"]; });
  const finalRecommendation = { ...recommendation, bestServicedBy: "2026-10-12T00:00:00.000Z", recommendedService: "repair" };
  const result = await analyzeCompletedVisit({
    unit: { _id: "unit-1", brand: "LG", modelName: "Dual Inverter", category: "split", capacityHp: 1.5 },
    serviceHistory: saved,
    recommendation,
    technicianId: "technician-1",
    providerCall: async () => ({ provider: "openai", model: "test-model", requestId: "request-integration", insight: { severity: "soon", follow_up_action: "repair_assessment", follow_up_days: 30, repair_or_replacement: "repair_may_be_needed", evidence_fact_ids: ["latest_findings"] } }),
    recalculate: async () => finalRecommendation,
  });
  assert.equal(saved.saveCalls, 1);
  assert.equal(saved.aiInterpretation.provider, "openai");
  assert.equal(saved.findings, service.findings);
  assert.equal(unitUpdate.sourceServiceHistoryId, "visit-1");
  assert.equal(unitUpdate.recommendedService, "repair");
  assert.equal(result.recommendation, finalRecommendation);
});
