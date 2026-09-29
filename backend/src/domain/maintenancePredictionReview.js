const crypto = require("node:crypto");
const Prediction = require("../models/MaintenancePrediction");
const { assessServiceEvidence, serviceTypeFor, serviceLabel } = require("./serviceEvidence");
const { formatDateKeyInTimeZone } = require("../utils/dateTime");
const ENGINE_VERSION = "history-interval-v1";
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
const numeric = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function buildPredictionSnapshot(unit, recommendation, capturedAt = new Date()) {
  const suggestedDate = date(recommendation.bestServicedBy);
  const anchorDate = date(recommendation.lastCleaningDate || unit.installation?.installedAt);
  if (!suggestedDate || !anchorDate || !["regular_cleaning", "deep_cleaning"].includes(recommendation.recommendedService)) return null;
  const basis = recommendation.historicalBasis || {};
  const evidence = {
    unit: String(unit._id), engineVersion: recommendation.aiPrediction?.engineVersion || ENGINE_VERSION,
    model: recommendation.aiPrediction?.model || "",
    evidenceFingerprint: recommendation.aiPrediction ? recommendation.predictionEvidence?.fingerprint || "" : "",
    suggestedDate: suggestedDate.toISOString(), anchorDate: anchorDate.toISOString(),
    recommendedService: recommendation.recommendedService,
    recommendationBasis: String(recommendation.recommendationBasis || ""),
    basisLevel: basis.level || "system_default", sampleSize: numeric(basis.sampleSize),
    comparableUnitCount: numeric(basis.comparableUnitCount), intervalDays: numeric(basis.intervalDays),
    excludedRecordCount: numeric(recommendation.dataQuality?.excludedRecordCount),
  };
  // Identical reports reuse the first capture; refreshes cannot rewrite the past.
  const _id = crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return { _id, ...evidence, capturedAt };
}

async function savePredictionSnapshot(unit, recommendation) {
  const snapshot = buildPredictionSnapshot(unit, recommendation);
  if (!snapshot) return null;
  try {
    await Prediction.updateOne({ _id: snapshot._id }, { $setOnInsert: snapshot }, { upsert: true, runValidators: true });
  } catch (error) {
    if (error.code !== 11000) throw error; // Concurrent identical captures share the same unique ID.
  }
  return snapshot._id;
}

function comparePredictionHistory(snapshots, history, { installedAt, asOfDate = new Date() } = {}) {
  const reviewDate = date(asOfDate) || new Date();
  const plans = snapshots.filter((p) => date(p.capturedAt) && date(p.suggestedDate) && date(p.capturedAt) <= reviewDate)
    .sort((a, b) => date(a.capturedAt) - date(b.capturedAt));
  const visits = history.filter((h) => date(h.serviceDate) && assessServiceEvidence(h, { installedAt, asOfDate }).eligible && ["regular_cleaning", "deep_cleaning"].includes(serviceTypeFor(h)))
    .sort((a, b) => date(a.serviceDate) - date(b.serviceDate));
  const matched = new Map();
  let previousVisit = null;
  for (const visit of visits) {
    const serviceDate = date(visit.serviceDate);
    // A plan must exist before the completed visit. Service history can be
    // migrated without `createdAt`, so it must never be required as evidence.
    const eligible = plans.filter((p) => date(p.capturedAt) < serviceDate && (!previousVisit || date(p.capturedAt) > previousVisit));
    const plan = eligible.at(-1);
    if (plan) matched.set(String(plan._id), visit);
    previousVisit = serviceDate;
  }
  return plans.slice().reverse().map((plan) => {
    const visit = matched.get(String(plan._id));
    const superseded = plans.some((p) => date(p.capturedAt) > date(plan.capturedAt));
    // Calendar difference describes scheduling, NOT prediction error or correctness.
    const daysFromSuggestedDate = visit ? Math.round((Date.parse(formatDateKeyInTimeZone(visit.serviceDate)) - Date.parse(formatDateKeyInTimeZone(plan.suggestedDate))) / 86400000) : null;
    return {
      id: String(plan._id), capturedAt: plan.capturedAt, suggestedDate: plan.suggestedDate,
      recommendedService: plan.recommendedService, recommendationBasis: plan.recommendationBasis,
      engineVersion: plan.engineVersion, basisLevel: plan.basisLevel, sampleSize: plan.sampleSize,
      comparableUnitCount: plan.comparableUnitCount, excludedRecordCount: plan.excludedRecordCount,
      status: visit ? "ready_for_review" : superseded ? "no_matched_visit" : "awaiting_visit",
      outcome: visit ? {
        serviceHistoryId: String(visit._id), serviceDate: visit.serviceDate,
        serviceLabel: serviceLabel(serviceTypeFor(visit)), findings: visit.findings || visit.technicianInputs?.notes || "",
        actionTaken: visit.actionTaken || (visit.serviceActions || []).join(", "), daysFromSuggestedDate,
      } : null,
    };
  });
}

async function loadPredictionReview(unit, history) {
  const snapshots = await Prediction.find({ unit: unit._id }).sort({ capturedAt: -1 }).limit(50).lean();
  return {
    entries: comparePredictionHistory(snapshots, history, { installedAt: unit.installation?.installedAt }),
    note: "Shows the latest 50 saved plans and completed cleaning visits. A plan can be compared only when it was saved before the visit. The date difference shows when service happened; it is not an AI score. Always review the technician's notes.",
  };
}
module.exports = { buildPredictionSnapshot, savePredictionSnapshot, comparePredictionHistory, loadPredictionReview };
