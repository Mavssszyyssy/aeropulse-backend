const test = require("node:test");
const assert = require("node:assert/strict");
const Unit = require("../src/models/Unit");
const History = require("../src/models/ServiceHistory");
const { serviceTypeFor, assessServiceEvidence } = require("../src/domain/serviceEvidence");
const { intervalSamplesForUnits, calculateMaintenanceRecommendation, cleaningMethodForDates } = require("../src/domain/ampMaintenanceService");
const { validateStrictServicePayload } = require("../src/domain/serviceCompletionService");
const { effectiveWarrantyStatus, buildActivatedWarranty } = require("../src/domain/warrantyService");
const { parseInstallationDateTime, businessDay } = require("../src/utils/dateTime");
const { maintenanceAlertForRecommendation } = require("../src/services/ampDailyMonitorService");
const { maintenanceSignalsFor } = require("../src/domain/ampMaintenanceSignals");

const finding = { serviceType: "regular_cleaning", findings: "Visible dust buildup on the evaporator coil.", actionTaken: "Cleaned the coil and flushed the drain.", conditionRating: "good" };
test("legacy installation and repair visits cannot be relabeled as cleaning", () => {
  for (const visitType of ["installation", "inspection", "repair"]) assert.equal(serviceTypeFor({ visitType, serviceType: "regular_cleaning" }), visitType);
  assert.equal(serviceTypeFor({ visitType: "scheduled_service", actionTaken: "Service completed" }), "unknown");
});
test("the screenshot's recommendation-only record is not evidence of cleaning", () => {
  const history = { ...finding, serviceDate: "2026-09-05", findings: "AMP recommended regular cleaning for this AC unit.", actionTaken: "Service completed" };
  assert.equal(assessServiceEvidence(history, { asOfDate: "2026-09-06" }).eligible, false);
  assert.equal(validateStrictServicePayload(history).ok, false);
});
test("future and pre-installation service dates are excluded", () => {
  assert.equal(assessServiceEvidence({ ...finding, serviceDate: "2027-01-01" }, { asOfDate: "2026-09-05" }).eligible, false);
  assert.equal(assessServiceEvidence({ ...finding, serviceDate: "2026-09-05T13:00:00Z" }, { asOfDate: "2026-09-05T12:00:00Z" }).eligible, false);
  assert.equal(assessServiceEvidence({ ...finding, serviceDate: "2026-01-01" }, { asOfDate: "2026-09-05", installedAt: "2026-02-01" }).eligible, false);
  assert.equal(validateStrictServicePayload({ ...finding, serviceDate: "2099-01-01", serviceActions: [finding.actionTaken] }).ok, false);
});
test("My Units preserves the Philippine installation day instead of the preceding UTC date", () => {
  const { serializeCustomerUnit } = require("../src/controllers/ampController");
  const result = serializeCustomerUnit({ _id: "unit", installation: { installedAt: "2026-09-05T16:00:00Z" } });
  assert.equal(result.installationDate, "2026-09-06");
});
test("My Units identifies an installed unit using its actual source order", () => {
  const { serializeCustomerUnit } = require("../src/controllers/ampController");
  const result = serializeCustomerUnit(
    { _id: "unit", serialNumber: "SERIAL-1", installation: { installedAt: "2026-09-10T00:00:00Z" } },
    [],
    null,
    null,
    { orderCode: "ORD-100", createdAt: "2026-09-08T12:00:00Z" },
  );
  assert.equal(result.orderCode, "ORD-100");
  assert.equal(result.purchaseDate, "2026-09-08T12:00:00Z");
});
test("My Units does not repeat the brand in the customer-facing unit name", () => {
  const { serializeCustomerUnit } = require("../src/controllers/ampController");
  const result = serializeCustomerUnit({ _id: "unit", brand: "TCL", modelName: "TCL Full DC Inverter", installation: {} });
  assert.equal(result.unitName, "TCL Full DC Inverter");
});
test("cohort intervals use actual cleaning evidence and ignore duplicate days and repairs", () => {
  const units = [{ _id: "a", installation: { installedAt: "2025-01-01" } }];
  const histories = [
    { ...finding, unit: "a", serviceDate: "2025-04-01" },
    { ...finding, unit: "a", serviceDate: "2025-04-01T01:00:00Z" },
    { ...finding, unit: "a", serviceDate: "2025-05-01", serviceType: "repair" },
    { ...finding, unit: "a", serviceDate: "2025-06-30" },
    { ...finding, unit: "a", serviceDate: "2026-12-31" },
  ];
  assert.deepEqual(intervalSamplesForUnits(units, histories, "2026-09-05"), [90]);
});
test("unit-specific cleaning patterns use calendar-month gaps and the arithmetic average", async (t) => {
  const fixture = { _id: "fixture", brand: "LG", modelName: "Test", category: "split", status: "active", amp: {}, installation: { installedAt: "2024-12-01" }, save: async () => {} };
  const rows = ["2025-01-10", "2025-05-10", "2025-09-15", "2026-01-20"].map((serviceDate) => ({ ...finding, unit: "fixture", serviceDate }));
  const chain = (items) => ({ sort() { return this; }, lean: async () => items });
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => { throw new Error("Comparable units must not replace sufficient unit history"); });
  t.mock.method(History, "find", () => chain(rows));
  const result = await calculateMaintenanceRecommendation("fixture", { asOfDate: "2026-02-01", serviceRequests: [], persist: false });
  assert.equal(result.historicalBasis.level, "same_unit");
  assert.deepEqual(result.historicalBasis.intervalsDays, [120, 120, 120]);
  assert.equal(result.historicalBasis.intervalDays, 120);
  assert.equal(result.bestServicedBy, "2026-05-20T00:00:00.000Z");
});
test("inconsistent five, four and six month cleaning gaps average to five months", () => {
  const unit = { _id: "fixture", installation: { installedAt: "2024-12-01" } };
  const rows = ["2025-01-10", "2025-06-10", "2025-10-10", "2026-04-10"].map((serviceDate) => ({ ...finding, unit: "fixture", serviceDate }));
  assert.deepEqual(intervalSamplesForUnits([unit], rows, "2026-05-01"), [150, 120, 180]);
});
test("maintenance context distinguishes dirt, deep cleaning and refrigerant work", () => {
  const signals = maintenanceSignalsFor([
    { serviceType: "repair", findings: "Dirty air filter restricted airflow.", actionTaken: "Replaced filter." },
    { serviceType: "repair", findings: "Dust buildup on the air filter.", actionTaken: "Cleaned the air filter." },
    { serviceType: "deep_cleaning", findings: "Dust buildup on the evaporator coil.", actionTaken: "Deep cleaned the evaporator coil." },
    { serviceType: "repair", findings: "Low refrigerant level.", actionTaken: "Recharged refrigerant." },
  ], [
    { issue: "Dust buildup on the evaporator coil.", status: "Submitted", createdAt: "2026-01-01" },
    { issue: "Control board inspection.", status: "Completed", createdAt: "2026-02-01" },
  ]);
  assert.equal(signals.filterDirtRecordCount, 2);
  assert.equal(signals.coilDirtRecordCount, 1);
  assert.equal(signals.deepCleaningRecordCount, 1);
  assert.equal(signals.coilMaintenanceRecordCount, 1);
  assert.equal(signals.refrigerantIssueRecordCount, 1);
  assert.equal(signals.serviceRequestFrequency.averageGapDays, 31);
  assert.deepEqual(signals.recurringProblems.map(item => item.code), ["filter_dirt"]);
  assert.equal(signals.refrigerantExcludedFromCleaningIntervals, true);
});
test("Philippine form dates and maintenance days do not depend on server timezone", () => {
  assert.equal(parseInstallationDateTime("2026-09-05", "16:14").toISOString(), "2026-09-05T08:14:00.000Z");
  assert.equal(parseInstallationDateTime("2026-02-30", "12:00"), null);
  assert.equal(businessDay("2026-09-05T16:30:00Z").toISOString(), "2026-09-06T00:00:00.000Z");
  const alert = maintenanceAlertForRecommendation({ bestServicedBy: "2026-09-06", recommendedService: "regular_cleaning" }, new Date("2026-09-06T10:00:00Z"));
  assert.equal(alert.daysUntilDue, 0);
  assert.notEqual(alert.tier, "amp_overdue");
});
test("missing history does not invent a cleaning method or active warranty", () => {
  assert.equal(cleaningMethodForDates({ asOfDate: "2026-09-05" }), "");
  assert.equal(effectiveWarrantyStatus({}), "pending_activation");
  assert.equal(effectiveWarrantyStatus({ status: "active" }), "pending_activation");
  assert.equal(buildActivatedWarranty({ status: "pending_activation" }, "2026-01-01").status, "active");
  assert.equal(buildActivatedWarranty({ status: "void" }, "2026-01-01").status, "void");
});
test("the no-history baseline adds exactly six calendar months and is not replaced by similar-unit data", async (t) => {
  const fixture = { _id: "fixture", brand: "LG", modelName: "New AC", category: "split", status: "active", amp: {}, installation: { installedAt: "2026-01-10" }, save: async () => {} };
  const chain = (items) => ({ sort() { return this; }, lean: async () => items });
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(History, "find", () => chain([]));
  const similarUnitCohort = { level: "same_model", sampleSize: 3, comparableUnitCount: 2, intervalDays: 120, samples: [120, 120, 120] };
  const result = await calculateMaintenanceRecommendation("fixture", {
    asOfDate: "2026-01-10",
    serviceRequests: [],
    persist: false,
    cohortCache: new Map([["lg:new ac:undefined:split", similarUnitCohort]]),
  });
  assert.equal(result.bestServicedBy, "2026-07-10T00:00:00.000Z");
  assert.equal(result.patternAnalysis.source, "system_default");
  assert.equal(result.historicalBasis.intervalDays, 180);
  assert.match(result.recommendationBasis, /6 calendar months \(180-day reference\)/);
});
test("recalculation preserves hold/retired status and does not invent missing dates", async (t) => {
  const chain = (rows) => ({ select() { return this; }, sort() { return this; }, lean: async () => rows });
  let fixture;
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => chain([]));
  t.mock.method(History, "find", () => chain([]));
  for (const status of ["on_hold", "retired", "active"]) {
    fixture = { _id: "fixture", brand: "LG", modelName: "Test", category: "split", status, amp: {}, installation: {}, save: async () => {} };
    const result = await calculateMaintenanceRecommendation("fixture", { asOfDate: "2026-09-05", serviceRequests: [] });
    assert.equal(result.bestServicedBy, null);
    assert.equal(result.recommendedService, "");
    assert.equal(fixture.status, status);
    assert.equal(result.dataQuality.anchorType, "missing");
  }
});
test("a repair does not move the cleaning anchor and an incomplete record stays visible in quality counts", async (t) => {
  const fixture = { _id: "fixture", brand: "LG", modelName: "Test", category: "split", status: "on_hold", amp: {}, installation: { installedAt: "2025-01-01" }, save: async () => {} };
  const rows = [
    { ...finding, serviceType: "repair", serviceDate: "2026-09-01" },
    { ...finding, serviceDate: "2026-08-01", findings: "AMP recommended regular cleaning for this AC unit.", actionTaken: "Service completed" },
    { ...finding, serviceDate: "2026-01-01" },
  ];
  const chain = (items) => ({ select() { return this; }, sort() { return this; }, lean: async () => items });
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => chain([]));
  t.mock.method(History, "find", () => chain(rows));
  const result = await calculateMaintenanceRecommendation("fixture", { asOfDate: "2026-09-05", serviceRequests: [] });
  assert.equal(result.lastCleaningDate, "2026-01-01T00:00:00.000Z");
  assert.equal(result.lastServiceDate, "2026-09-01T00:00:00.000Z");
  assert.equal(result.bestServicedBy, "2026-07-01T00:00:00.000Z");
  assert.equal(result.dataQuality.excludedRecordCount, 1);
  assert.equal(fixture.status, "on_hold");
  assert.match(result.recommendationBasis, /6 calendar months \(180-day reference\)/);
});

test("technician report validation rejects placeholder and repeated-character text", () => {
  for (const findings of ["testing only", "aaaaaaaaaaaa", "123456789012", "qwertyqwerty"]) {
    assert.equal(validateStrictServicePayload({
      ...finding,
      findings,
      serviceActions: [finding.actionTaken],
      serviceDate: "2026-09-05",
    }).ok, false);
  }
  assert.equal(validateStrictServicePayload({
    ...finding,
    findings: "Madumi ang filter at mahina ang buga ng hangin.",
    serviceActions: ["Nilinis ang filter at sinubukan ang paglamig."],
    serviceDate: "2026-09-05",
  }).ok, true);
});

test("permanent customer service history includes recorded work resources and costs", () => {
  const { serializeCustomerUnit } = require("../src/controllers/ampController");
  const result = serializeCustomerUnit({ _id: "unit", installation: {} }, [{
    _id: "service-1",
    serviceDate: "2026-09-05",
    ...finding,
    hoursSpent: 2.5,
    laborCost: 500,
    partsCost: 200,
    additionalCost: 0,
    totalServiceCost: 700,
  }]);
  assert.equal(result.serviceHistory[0].hoursSpent, 2.5);
  assert.equal(result.serviceHistory[0].laborCost, 500);
  assert.equal(result.serviceHistory[0].partsCost, 200);
  assert.equal(result.serviceHistory[0].totalServiceCost, 700);
});
test("the latest validated AI visit follow-up overrides the routine plan without changing the cleaning anchor", async (t) => {
  const summary = "The technician recorded an unusual fan noise. An inspection is recommended by 2026-10-01.";
  const fixture = {
    _id: "fixture", brand: "LG", modelName: "Test", category: "split", status: "active",
    installation: { installedAt: "2025-01-01" },
    amp: { visitFollowUp: { sourceServiceHistoryId: "visit-1", provider: "openai", severity: "soon", recommendedService: "inspection", recommendedDate: "2026-10-01", customerSummary: summary } },
    save: async () => {},
  };
  const rows = [
    { _id: "visit-1", ...finding, serviceType: "repair", serviceDate: "2026-09-01", findings: "The fan made an unusual noise.", actionTaken: "Tested cooling and recorded the noise." },
    { _id: "clean-1", ...finding, serviceDate: "2026-01-01" },
  ];
  const chain = (items) => ({ select() { return this; }, sort() { return this; }, lean: async () => items });
  t.mock.method(Unit, "findById", async () => fixture);
  t.mock.method(Unit, "find", () => chain([]));
  t.mock.method(History, "find", () => chain(rows));
  const result = await calculateMaintenanceRecommendation("fixture", { asOfDate: "2026-09-05", serviceRequests: [], persist: false });
  assert.equal(result.recommendedService, "inspection");
  assert.equal(result.bestServicedBy, "2026-10-01T00:00:00.000Z");
  assert.equal(result.recommendationBasis, summary);
  assert.equal(result.lastCleaningDate, "2026-01-01T00:00:00.000Z");
  assert.equal(result.latestVisitAnalysis.sourceServiceHistoryId, "visit-1");
});
test("equal horsepower in a different category is brand evidence, not same-type evidence", async (t) => {
  const unit = { _id: "target", brand: "LG", modelName: "Split A", category: "split", capacityHp: 1, installation: { installedAt: "2026-06-01" } };
  const other = { _id: "other", brand: "LG", modelName: "Window B", category: "window", capacityHp: 1, installation: { installedAt: "2025-01-01" } };
  const rows = ["2025-04-01", "2025-07-01", "2025-09-30"].map((serviceDate) => ({ ...finding, unit: "other", serviceDate }));
  const targetHistory = [{ ...finding, unit: "target", serviceType: "repair", serviceDate: "2026-07-01" }];
  const chain = (items) => ({ select() { return this; }, sort() { return this; }, lean: async () => items });
  t.mock.method(Unit, "findById", async () => unit);
  t.mock.method(Unit, "find", () => chain([unit, other]));
  t.mock.method(History, "find", (query) => chain(query.unit === "target" ? targetHistory : rows));
  const brandOnly = await calculateMaintenanceRecommendation("target", { asOfDate: "2026-09-05", persist: false, serviceRequests: [] });
  assert.equal(brandOnly.historicalBasis.level, "same_brand");
  other.category = "split";
  const sameType = await calculateMaintenanceRecommendation("target", { asOfDate: "2026-09-05", persist: false, serviceRequests: [] });
  assert.equal(sameType.historicalBasis.level, "same_brand_type");
});
