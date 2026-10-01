const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("../src/config/env");
const Unit = require("../src/models/Unit");
const History = require("../src/models/ServiceHistory");
const { calculateMaintenanceRecommendation } = require("../src/domain/ampMaintenanceService");
const { predictionEvidence, validPrediction, ENGINE_VERSION } = require("../src/domain/ampPrediction");
const { callStructuredAmpAnalysis } = require("../src/services/openAiAmpService");
const { getMaintenanceRecommendation, generateAmpReport, predictAndSave } = require("../src/controllers/aiController");
const { listWarrantyClaims } = require("../src/controllers/warrantyController");
const { getReportUnits, serializeReportUnit } = require("../src/controllers/ampController");
const { assertAmpBranch } = require("../src/domain/ampAccess");
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const chain = rows => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => rows, then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); } });
const unitId = "64fa00000000000000000001";
const evidence = () => predictionEvidence({ unit: { brand: "LG", modelName: "AC", capacityHp: 2 },
  cohort: { level: "same_model", sampleSize: 3, comparableUnitCount: 2, intervalDays: 180, samples: [120, 180, 240] },
  ownHistory: [], lastCleaningDate: null, installedAt: "2026-01-01", asOfDate: "2026-09-08",
  maintenanceSignals: { filterDirtRecordCount: 1 } });

test("report units include linked customer and installation address identifiers", () => {
  assert.deepEqual(serializeReportUnit({
    _id: "unit-1",
    customer: { _id: "customer-1", name: "Patrick Cruz" },
    brand: "TCL",
    modelName: "Window 1.5HP",
    serialNumber: "CAACT-001",
    serviceBranch: "Cavite",
    status: "active",
    installation: { addressLine: "591 Street", city: "Bacoor", province: "Cavite", zipCode: "4102" },
  }), {
    unitId: "unit-1",
    customerId: "customer-1",
    customerName: "Patrick Cruz",
    capacityHp: null,
    modelName: "TCL Window 1.5HP",
    serialNumber: "CAACT-001",
    branch: "Cavite",
    status: "active",
    installationAddress: "591 Street, Bacoor, Cavite, 4102",
  });
});

test("prediction validates interval and reason without allowing policy/diagnosis overrides", () => {
  assert.equal(validPrediction({ interval_days: 120, reason_code: "earlier_interval" }, evidence()), true);
  for (const raw of [
    { interval_days: 800, reason_code: "later_interval" }, { interval_days: 150, reason_code: "earlier_interval" },
    { interval_days: 180.5, reason_code: "later_interval" }, { interval_days: "180", reason_code: "typical_interval" },
    { interval_days: 180, reason_code: "typical_interval", warranty: "approved" },
  ]) assert.equal(validPrediction(raw, evidence()), false);
  assert.equal(validPrediction({ interval_days: 180, reason_code: "typical_interval" }, { ...evidence(), eligible: false }), false);
  const noDirtEvidence = predictionEvidence({ unit: { brand: "LG", modelName: "AC", capacityHp: 2 },
    cohort: { level: "same_model", sampleSize: 3, comparableUnitCount: 2, intervalDays: 180, samples: [120, 180, 240] },
    ownHistory: [], lastCleaningDate: null, installedAt: "2026-01-01", asOfDate: "2026-09-08" });
  assert.deepEqual(noDirtEvidence.candidateIntervals, [180]);
  assert.equal(validPrediction({ interval_days: 120, reason_code: "earlier_interval" }, noDirtEvidence), false);
});

test("real request builder sends timing evidence only and accepts an AI interval different from baseline", async t => {
  const key = env.openAiApiKey; env.openAiApiKey = "test-only"; t.after(() => { env.openAiApiKey = key; });
  let calls = 0;
  t.mock.method(global, "fetch", async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const sent = JSON.parse(body.input[1].content[0].text);
    assert.equal(body.text.format.name, "amp_maintenance_prediction");
    assert.deepEqual(sent.evidence.cohort.intervalHistogram, { 120: 1, 180: 1, 240: 1 });
    assert.equal(JSON.stringify(body).includes("private-person"), false);
    assert.equal(body.store, false);
    assert.deepEqual(body.text.format.schema.properties.interval_days.enum, [120, 180]);
    return { ok: true, headers: { get: () => "req_prediction" }, text: async () => JSON.stringify({ status: "completed", output_text: JSON.stringify({ interval_days: 120, reason_code: "earlier_interval" }) }) };
  });
  const recommendation = { bestServicedBy: "2026-06-30", recommendedService: "regular_cleaning", predictionEvidence: evidence() };
  const input = { safetyIdentifier: "prediction-test", predictionMode: true, recommendation, recordedHistory: [{ findings: "private-person" }] };
  const result = await callStructuredAmpAnalysis(input);
  assert.equal(result.provider, "openai"); assert.equal(result.insight.interval_days, 120);
  assert.equal((await callStructuredAmpAnalysis(input)).cached, true); assert.equal(calls, 1);
  const afterSave = { ...input, recommendation: { ...recommendation, bestServicedBy: "2026-05-31", aiPrediction: { generatedAt: new Date().toISOString() }, recommendationBasis: "AI-estimated interval" } };
  assert.equal((await callStructuredAmpAnalysis(afterSave)).cached, true); assert.equal(calls, 1);
  assert.equal((await callStructuredAmpAnalysis({ ...input, recommendation: { ...recommendation, predictionEvidence: { ...evidence(), eligible: false } } })).provider, "system-fallback");
  assert.equal(calls, 1);
});

test("a current saved prediction is reused across server instances without another provider call", async t => {
  t.mock.method(global, "fetch", () => {
    throw new Error("A current persisted prediction must not call the provider");
  });
  const recommendation = {
    predictionSource: "openai",
    aiPrediction: { model: "saved-model", generatedAt: "2026-09-30T00:00:00.000Z" },
    predictionEvidence: evidence(),
    bestServicedBy: "2026-06-30T00:00:00.000Z",
  };
  const result = await predictAndSave(
    { authUser: { _id: "customer" } },
    { _id: unitId },
    recommendation,
  );
  assert.equal(result.ai.provider, "openai");
  assert.equal(result.ai.persisted, true);
  assert.equal(result.ai.cached, true);
  assert.equal(result.recommendation, recommendation);
});

test("branchless admins cannot list warranty claims or report units or request paid AI; assigned scope is enforced", async t => {
  t.mock.method(Unit, "find", () => { throw new Error("Must reject before querying records"); });
  t.mock.method(Unit, "findById", () => { throw new Error("Must reject before querying unit"); });
  for (const handler of [listWarrantyClaims, getReportUnits, getMaintenanceRecommendation, generateAmpReport]) {
    const res = response();
    await handler({ authUser: { role: "admin", _id: "admin" }, activeBranch: "", body: { unitId } }, res);
    assert.equal(res.statusCode, 403, handler.name);
  }
  assert.doesNotThrow(() => assertAmpBranch({ authUser: { role: "admin" }, activeBranch: "Cavite" }, { serviceBranch: "Cavite" }));
  for (const serviceBranch of ["Bulacan", "", undefined]) assert.throws(() => assertAmpBranch({ authUser: { role: "admin" }, activeBranch: "Cavite" }, { serviceBranch }), { status: 403 });
  assert.doesNotThrow(() => assertAmpBranch({ authUser: { role: "superadmin" } }, { serviceBranch: "Bulacan" }));
});

test("saved AI date survives normal reads, drives reminders, and invalidates after a new cleaning", async t => {
  const fixture = { _id: unitId, customer: "customer", serviceBranch: "Cavite", brand: "LG", modelName: "AC", category: "split", capacityHp: 2,
    status: "active", amp: {}, installation: { installedAt: "2026-01-01" }, save: async () => {} };
  let ownHistory = [{ serviceDate: "2026-04-01", serviceType: "repair", findings: "Dust buildup on the air filter.", actionTaken: "Cleaned the air filter." }];
  const cohort = { level: "same_model", sampleSize: 3, comparableUnitCount: 2, intervalDays: 180, samples: [120, 180, 240] };
  const options = { asOfDate: "2026-09-08", serviceRequests: [{ issue: "Dust buildup on the air filter.", status: "Completed" }], cohortCache: new Map([["lg:ac:2:split", cohort]]) };
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(History, "find", () => chain(ownHistory));
  const baseline = await calculateMaintenanceRecommendation(unitId, options);
  fixture.amp.aiPrediction = { engineVersion: ENGINE_VERSION, fingerprint: baseline.predictionEvidence.fingerprint,
    generatedAt: "2026-09-07", model: "gpt-5.6-terra", prediction: { interval_days: 120, reason_code: "earlier_interval" } };
  const predicted = await calculateMaintenanceRecommendation(unitId, options);
  assert.equal(predicted.predictionSource, "openai");
  assert.equal(predicted.bestServicedBy, "2026-05-01T00:00:00.000Z");
  assert.equal(fixture.amp.nextIdealServiceDate.toISOString(), predicted.bestServicedBy);
  assert.equal(predicted.overdue, true);
  const { maintenanceAlertForRecommendation } = require("../src/services/ampDailyMonitorService");
  assert.equal(maintenanceAlertForRecommendation(predicted, new Date("2026-09-08")).tier, "amp_overdue");
  ownHistory = [{ serviceDate: "2026-09-07", serviceType: "regular_cleaning", findings: "Dust buildup on coil.", actionTaken: "Cleaned coil and drain." }];
  const refreshed = await calculateMaintenanceRecommendation(unitId, options);
  assert.equal(refreshed.predictionSource, "system");
  assert.notEqual(refreshed.bestServicedBy, predicted.bestServicedBy);
  assert.equal(refreshed.historicalBasis.intervalDays, 180);
});

test("report generation persists the AI interval, returns the same date and captures AI provenance without changing warranty", async t => {
  const fixture = { _id: unitId, customer: "customer", serviceBranch: "Cavite", brand: "LG", modelName: "AC", category: "split", capacityHp: 2,
    status: "active", amp: {}, installation: { installedAt: "2026-01-01" }, warranty: { status: "pending_activation" }, save: async () => {} };
  const peer = { _id: "peer", brand: "LG", modelName: "AC", category: "split", capacityHp: 2, installation: { installedAt: "2025-01-01" } };
  const histories = ["2025-05-01", "2025-09-28", "2026-02-25"].map(serviceDate => ({ unit: "peer", serviceDate, serviceType: "regular_cleaning", findings: "Dust buildup on coil.", actionTaken: "Cleaned coil and drain." }));
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => chain([fixture, peer]));
  const targetHistory = [{ unit: unitId, serviceDate: "2026-04-01", serviceType: "repair", findings: "Dust buildup on the air filter.", actionTaken: "Cleaned the air filter." }];
  t.mock.method(History, "find", query => chain(query.unit === unitId ? targetHistory : histories));
  t.mock.method(Unit, "updateOne", async (_query, update) => { fixture.amp.aiPrediction = update.$set["amp.aiPrediction"]; return { matchedCount: 1 }; });
  t.mock.method(require("../src/models/ServiceRequest"), "find", () => chain([]));
  t.mock.method(require("../src/models/Task"), "find", () => chain([]));
  let snapshot;
  t.mock.method(require("../src/models/MaintenancePrediction"), "updateOne", async (_query, update) => { snapshot = update.$setOnInsert; });
  const key = env.openAiApiKey; env.openAiApiKey = "test-report-only"; t.after(() => { env.openAiApiKey = key; });
  t.mock.method(global, "fetch", async () => ({ ok: true, headers: { get: () => "req_controller" }, text: async () => JSON.stringify({ status: "completed", output_text: JSON.stringify({ interval_days: 150, reason_code: "typical_interval" }) }) }));
  const res = response();
  await generateAmpReport({ authUser: { _id: "customer", role: "customer" }, activeBranch: "", body: { unitId, reportType: "predictive_maintenance" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, "openai");
  assert.equal(res.body.report.maintenance.predictionSource, "openai");
  assert.equal(res.body.report.maintenance.bestServicedBy, "2026-06-01T00:00:00.000Z");
  assert.equal(fixture.amp.bestServicedBy.toISOString(), res.body.report.maintenance.bestServicedBy);
  assert.equal(snapshot.engineVersion, ENGINE_VERSION);
  assert.equal(snapshot.suggestedDate, res.body.report.maintenance.bestServicedBy);
  assert.equal(fixture.warranty.status, "pending_activation");
  // Subsequent customer unit reads use the estimate without another provider request.
  t.mock.method(global, "fetch", () => { throw new Error("Read must not call AI"); });
  const saved = await calculateMaintenanceRecommendation(unitId);
  assert.equal(saved.predictionSource, "openai");
  assert.equal(saved.bestServicedBy, snapshot.suggestedDate);
});

test("invalid prediction, provider outage and missing key cannot save an AI date", async t => {
  const originalKey = env.openAiApiKey; const retries = env.openAiMaxRetries;
  t.after(() => { env.openAiApiKey = originalKey; env.openAiMaxRetries = retries; });
  env.openAiApiKey = "test-invalid-prediction"; env.openAiMaxRetries = 0;
  const input = { predictionMode: true, recommendation: { bestServicedBy: "2026-06-30", recommendedService: "regular_cleaning", predictionEvidence: evidence() } };
  t.mock.method(global, "fetch", async () => ({ ok: true, headers: { get: () => "req_invalid" }, text: async () => JSON.stringify({ output_text: JSON.stringify({ interval_days: 700, reason_code: "later_interval" }) }) }));
  assert.equal((await callStructuredAmpAnalysis(input)).provider, "system-fallback");
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503, headers: { get: () => "req_outage" } }));
  assert.equal((await callStructuredAmpAnalysis(input)).provider, "system-fallback");
  env.openAiApiKey = "";
  t.mock.method(global, "fetch", () => { throw new Error("No key must not call AI"); });
  assert.equal((await callStructuredAmpAnalysis(input)).provider, "system-fallback");
});

test("history changed during the provider request is rejected before any prediction write", async t => {
  const fixture = { _id: unitId, customer: "race-customer", serviceBranch: "Cavite", brand: "LG", modelName: "AC", category: "split", capacityHp: 2,
    status: "active", amp: {}, installation: { installedAt: "2026-01-01" }, save: async () => {} };
  const peer = { _id: "peer", brand: "LG", modelName: "AC", category: "split", capacityHp: 2, installation: { installedAt: "2025-01-01" } };
  const record = { unit: "peer", serviceType: "regular_cleaning", findings: "Dust buildup on coil.", actionTaken: "Cleaned coil and drain." };
  let ownHistory = [{ ...record, unit: unitId, serviceType: "repair", serviceDate: "2026-04-01" }];
  const histories = ["2025-05-01", "2025-09-28", "2026-02-25"].map(serviceDate => ({ ...record, serviceDate }));
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => chain([fixture, peer]));
  t.mock.method(History, "find", query => chain(query.unit === unitId ? ownHistory : histories));
  t.mock.method(require("../src/models/ServiceRequest"), "find", () => chain([]));
  t.mock.method(Unit, "updateOne", () => { throw new Error("Stale estimate must not be written"); });
  const key = env.openAiApiKey; env.openAiApiKey = "test-race-only"; t.after(() => { env.openAiApiKey = key; });
  t.mock.method(global, "fetch", async () => {
    ownHistory = [{ ...record, unit: unitId, serviceDate: "2026-08-01" }];
    return { ok: true, headers: { get: () => "req_race" }, text: async () => JSON.stringify({ output_text: JSON.stringify({ interval_days: 150, reason_code: "typical_interval" }) }) };
  });
  const res = response();
  await getMaintenanceRecommendation({ authUser: { _id: "race-customer", role: "customer" }, body: { unitId } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, "system-fallback");
  assert.match(res.body.warning, /history changed/i);
  assert.equal(res.body.recommendation.lastCleaningDate, "2026-08-01T00:00:00.000Z");
  assert.equal(fixture.amp.aiPrediction, undefined);
});
