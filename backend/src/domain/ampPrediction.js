const crypto = require("node:crypto");
const { businessDay } = require("../utils/dateTime");
const ENGINE_VERSION = "openai-maintenance-v2";
const REASONS = ["earlier_interval", "typical_interval", "later_interval"];
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Only validated, de-identified timing evidence crosses the provider boundary.
// The 3–12 month envelope is an engineering safeguard, not a warranty policy.
function predictionEvidence({ unit, cohort, ownHistory, lastCleaningDate, installedAt, asOfDate, patternAnalysis = {}, maintenanceSignals = {} }) {
  const histogram = {};
  for (const days of cohort.samples || []) histogram[days] = (histogram[days] || 0) + 1;
  const anchor = lastCleaningDate || installedAt;
  const evidence = {
    version: ENGINE_VERSION,
    brand: String(unit.brand || "").slice(0, 100), model: String(unit.modelName || "").slice(0, 150),
    category: String(unit.category || "").slice(0, 50), capacityHp: Number(unit.capacityHp) || null,
    anchorDate: anchor ? businessDay(anchor).toISOString() : null,
    cohort: { level: cohort.level, sampleSize: cohort.sampleSize, comparableUnitCount: cohort.comparableUnitCount,
      intervalHistogram: histogram, baselineIntervalDays: cohort.intervalDays, calculation: patternAnalysis.calculation || "arithmetic_mean" },
    ownServices: ownHistory.map(h => ({ date: businessDay(h.serviceDate).toISOString(), type: h.normalizedType }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type)),
    contextSignals: {
      completedServiceCount: Number(maintenanceSignals.completedServiceCount || 0),
      cleaningRecordCount: Number(maintenanceSignals.cleaningRecordCount || 0),
      repairRecordCount: Number(maintenanceSignals.repairRecordCount || 0),
      serviceRequestCount: Number(maintenanceSignals.serviceRequestCount || 0),
      averageCompletedServiceGapDays: Number(maintenanceSignals.completedServiceFrequency?.averageGapDays) || null,
      averageServiceRequestGapDays: Number(maintenanceSignals.serviceRequestFrequency?.averageGapDays) || null,
      filterDirtRecordCount: Number(maintenanceSignals.filterDirtRecordCount || 0),
      coilDirtRecordCount: Number(maintenanceSignals.coilDirtRecordCount || 0),
      deepCleaningRecordCount: Number(maintenanceSignals.deepCleaningRecordCount || 0),
      coilMaintenanceRecordCount: Number(maintenanceSignals.coilMaintenanceRecordCount || 0),
      refrigerantIssueRecordCount: Number(maintenanceSignals.refrigerantIssueRecordCount || 0),
      recurringProblems: (maintenanceSignals.recurringProblems || []).map(item => ({ code: item.code, count: item.count })).slice(0, 10),
      refrigerantExcludedFromCleaningIntervals: true,
    },
  };
  const samples = Object.keys(histogram).map(Number);
  const baseline = Math.max(90, Math.min(360, Number(cohort.intervalDays) || 180));
  const earlierIntervalSupported = evidence.contextSignals.filterDirtRecordCount > 0 || evidence.contextSignals.coilDirtRecordCount > 0;
  // The provider can only select the arithmetic mean or, when dirt evidence exists,
  // a shorter interval that was actually observed. It cannot invent a day count.
  const candidateIntervals = [...new Set([
    baseline,
    ...(earlierIntervalSupported ? samples.filter(days => days < baseline) : []),
  ].map(days => Math.max(90, Math.min(360, days))))].sort((a, b) => a - b);
  const fingerprintEvidence = { ...evidence, ownServices: evidence.ownServices.slice(-50), candidateIntervals,
    decisionSupport: { earlierIntervalSupported } };
  const finalized = { ...fingerprintEvidence, asOfDate: businessDay(asOfDate).toISOString(),
    eligible: Boolean(anchor && cohort.level !== "system_default" && cohort.sampleSize >= 2 && samples.length),
    minimumDays: candidateIntervals[0] || baseline, maximumDays: candidateIntervals.at(-1) || baseline,
  };
  return { ...finalized, fingerprint: hash(fingerprintEvidence) };
}

function validPrediction(raw, evidence) {
  if (!evidence?.eligible || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (Object.keys(raw).sort().join(",") !== "interval_days,reason_code") return false;
  const days = raw.interval_days;
  if (!Number.isInteger(days) || !evidence.candidateIntervals?.includes(days) || !REASONS.includes(raw.reason_code)) return false;
  const baseline = evidence.cohort.baselineIntervalDays;
  const expectedReason = days < baseline ? "earlier_interval" : days > baseline ? "later_interval" : "typical_interval";
  return raw.reason_code === expectedReason
    && (expectedReason !== "earlier_interval" || evidence.decisionSupport?.earlierIntervalSupported === true);
}

function predictionBasis(prediction, evidence) {
  const direction = { earlier_interval: "an earlier", typical_interval: "the typical", later_interval: "a later" }[prediction.reason_code];
  const source = evidence.cohort.level === "same_unit" ? "this AC unit" : evidence.cohort.level.replaceAll("_", " ");
  const intervals = Object.entries(evidence.cohort.intervalHistogram || {}).flatMap(([days, count]) => Array(Number(count)).fill(Number(days)));
  const range = intervals.length ? ` The verified interval range is ${Math.min(...intervals)}–${Math.max(...intervals)} days.` : "";
  const dirtCount = Number(evidence.contextSignals?.filterDirtRecordCount || 0) + Number(evidence.contextSignals?.coilDirtRecordCount || 0);
  const dirtReason = prediction.reason_code === "earlier_interval" && dirtCount
    ? ` A shorter observed interval was selected because ${dirtCount} filter/coil dirt-related record(s) were found.`
    : dirtCount ? ` ${dirtCount} filter/coil dirt-related record(s) were reviewed; the calculated average remained the selected interval.` : "";
  const depthCount = Number(evidence.contextSignals?.deepCleaningRecordCount || 0) + Number(evidence.contextSignals?.coilMaintenanceRecordCount || 0);
  const depthNote = depthCount ? ` ${depthCount} deep/coil-cleaning record(s) were retained as service-depth context.` : "";
  const refrigerantNote = evidence.contextSignals?.refrigerantIssueRecordCount
    ? ` ${evidence.contextSignals.refrigerantIssueRecordCount} refrigerant-related record(s) were reviewed as context but were not counted as cleaning intervals.`
    : " Repairs and refrigerant issues are context only and are not counted as cleaning intervals.";
  const selectedMonths = Math.max(1, Math.round(prediction.interval_days / 30));
  const baselineMonths = Math.max(1, Math.round(evidence.cohort.baselineIntervalDays / 30));
  return `AI-estimated servicing interval: ${selectedMonths} calendar month(s) after the last verified cleaning or installation (${prediction.interval_days} days is the normalized comparison value). OpenAI selected ${direction} evidence-backed interval from ${evidence.cohort.sampleSize} verified cleaning interval(s) for ${source}; the normalized arithmetic average is ${baselineMonths} calendar month(s) (${evidence.cohort.baselineIntervalDays} days).${range}${dirtReason}${depthNote}${refrigerantNote} The selected interval is restricted to the calculated average or a shorter interval actually present in the verified history. It is not a guaranteed failure date, confirmed booking, or warranty decision.`;
}

function savedPredictionIsCurrent(saved, evidence, asOfDate) {
  return saved?.engineVersion === ENGINE_VERSION && saved.fingerprint === evidence.fingerprint
    && Number.isFinite(Date.parse(saved.generatedAt)) && new Date(saved.generatedAt) <= new Date(asOfDate)
    && validPrediction(saved.prediction, evidence);
}

module.exports = { ENGINE_VERSION, REASONS, predictionEvidence, validPrediction, predictionBasis, savedPredictionIsCurrent };
