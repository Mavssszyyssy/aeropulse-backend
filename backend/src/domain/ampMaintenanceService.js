const mongoose = require("mongoose");
const Product = require("../models/Product");
const ServiceRequest = require("../models/ServiceRequest");
const ServiceHistory = require("../models/ServiceHistory");
const Unit = require("../models/Unit");
const { serviceTypeFor, assessServiceEvidence } = require("./serviceEvidence");
const { maintenanceSignalsFor } = require("./ampMaintenanceSignals");
const { businessDay } = require("../utils/dateTime");
const { predictionEvidence, predictionBasis, savedPredictionIsCurrent } = require("./ampPrediction");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SERVICE_INTERVAL_DAYS = 180;
const MIN_HISTORICAL_SAMPLES = 2;

const asDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const startOfUtcDay = (value = new Date()) => {
  return businessDay(value);
};

const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
const addCalendarMonths = (date, intervalDays) => {
  const months = Math.max(1, Math.round(Number(intervalDays || 0) / 30));
  const day = date.getUTCDate();
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalize = (value) => String(value || "").trim().toLowerCase();

const average = (values = [], fallback = DEFAULT_SERVICE_INTERVAL_DAYS) => {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 30 && value <= 730);
  if (!valid.length) return fallback;
  const averageMonths = Math.round(valid.reduce((total, value) => total + Math.round(value / 30), 0) / valid.length);
  return Math.max(1, averageMonths) * 30;
};

const normalizeServiceType = serviceTypeFor;

const serviceDatesFor = (histories = []) => histories
  .filter((history) => ["regular_cleaning", "deep_cleaning"].includes(normalizeServiceType(history)))
  .map((history) => asDate(history.serviceDate))
  .filter(Boolean)
  .sort((a, b) => a.getTime() - b.getTime());

const intervalSamplesForUnits = (units = [], histories = [], asOfDate = new Date()) => {
  const historyByUnit = new Map();
  histories.forEach((history) => {
    const key = String(history.unit || "");
    const current = historyByUnit.get(key) || [];
    current.push(history);
    historyByUnit.set(key, current);
  });

  const samples = [];
  units.forEach((unit) => {
    const validHistory = (historyByUnit.get(String(unit._id || unit.id)) || [])
      .filter((history) => assessServiceEvidence(history, { asOfDate, installedAt: unit.installation?.installedAt }).eligible);
    const dates = [...new Set(serviceDatesFor(validHistory).map((date) => businessDay(date).getTime()))].map((date) => new Date(date));
    // Installation is the fallback anchor, not proof of a cleaning. Only gaps
    // between two verified cleanings are historical cleaning intervals.
    for (let index = 1; index < dates.length; index += 1) {
      const exactDays = daysBetween(dates[index - 1], dates[index]);
      const interval = Math.max(1, Math.round(exactDays / 30.4375)) * 30;
      if (exactDays >= 30 && exactDays <= 730) samples.push(interval);
    }
  });
  return samples;
};

const selectHistoricalCohort = (levels = []) => {
  const selected = levels.find((item) => item.samples.length >= MIN_HISTORICAL_SAMPLES);
  if (selected) {
    return {
      level: selected.level,
      intervalDays: clamp(average(selected.samples), 90, 360),
      sampleSize: selected.samples.length,
      comparableUnitCount: selected.units.length,
      unitIds: selected.units.map((candidate) => candidate._id),
      samples: selected.samples,
    };
  }
  return {
    level: "system_default",
    intervalDays: DEFAULT_SERVICE_INTERVAL_DAYS,
    sampleSize: 0,
    comparableUnitCount: 0,
    unitIds: [],
    samples: [],
  };
};

const resolveProductCategory = async (unit) => {
  if (unit.category) return normalize(unit.category);
  if (!mongoose.isValidObjectId(String(unit.productId || ""))) return "";
  const product = await Product.findById(unit.productId).select("category").lean();
  return normalize(product?.category);
};

const collectHistoricalCohort = async (unit, asOfDate) => {
  const category = await resolveProductCategory(unit);
  if (!normalize(unit.brand)) return selectHistoricalCohort([]);
  const escapedBrand = String(unit.brand).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allComparable = await Unit.find({
    brand: new RegExp(`^${escapedBrand}$`, "i"),
    status: { $ne: "retired" },
  }).select("brand modelName capacityHp category installation.installedAt").lean();

  const sameBrand = allComparable.filter((candidate) => normalize(candidate.brand) === normalize(unit.brand));
  const sameModel = sameBrand.filter((candidate) => normalize(unit.modelName) && normalize(candidate.modelName) === normalize(unit.modelName) && Number(candidate.capacityHp) === Number(unit.capacityHp));
  const sameBrandType = sameBrand.filter((candidate) => {
    const categoryMatch = category && normalize(candidate.category) === category;
    const hp = Number(candidate.capacityHp || 0);
    const targetHp = Number(unit.capacityHp || 0);
    const capacityMatch = hp && targetHp && Math.abs(hp - targetHp) <= 0.5;
    // Do not call an equal-HP window unit the same "type" as a split unit.
    // Include same-model records here too when that narrower cohort is sparse.
    return Boolean(categoryMatch && (!hp || !targetHp || capacityMatch));
  });
  const ids = allComparable.map((candidate) => candidate._id);
  const histories = ids.length
    ? await ServiceHistory.find({ unit: { $in: ids } }).sort({ serviceDate: 1 }).lean()
    : [];

  const samplesFor = (units) => intervalSamplesForUnits(units, histories, asOfDate);
  const levels = [
    { level: "same_model", units: sameModel, samples: samplesFor(sameModel) },
    { level: "same_brand_type", units: sameBrandType, samples: samplesFor(sameBrandType) },
    { level: "same_brand", units: sameBrand, samples: samplesFor(sameBrand) },
  ];
  return selectHistoricalCohort(levels);
};

const basisText = ({ level, intervalDays, sampleSize, samples = [] }) => {
  const months = Math.max(1, Math.round(intervalDays / 30));
  const range = samples.length ? ` The verified cycle range is about ${Math.round(Math.min(...samples) / 30)}–${Math.round(Math.max(...samples) / 30)} calendar month(s).` : "";
  const average = `Their normalized arithmetic average is ${months} calendar month(s); ${intervalDays} days is retained as the comparison value.`;
  if (level === "same_unit") return `Based on this AC unit's ${sampleSize} verified cleaning interval(s). ${average}${range}`;
  if (level === "same_model") return `This AC does not yet have two verified cleaning intervals, so the plan uses ${sampleSize} interval(s) from the same model. ${average}${range}`;
  if (level === "same_brand_type") return `This AC does not yet have two verified cleaning intervals, so the plan uses ${sampleSize} interval(s) from AC units of the same brand and type. ${average}${range}`;
  if (level === "same_brand") return `This AC does not yet have two verified cleaning intervals, so the plan uses ${sampleSize} interval(s) from the same brand. ${average}${range}`;
  return "Insufficient service history. Default recommended cleaning interval: 6 calendar months (180-day reference). This baseline is replaced when enough verified cleaning intervals become available.";
};

const patternAnalysisFor = (cohort) => ({
  source: cohort.level,
  calculation: cohort.level === "system_default" ? "six_month_baseline" : "arithmetic_mean",
  intervalCount: cohort.sampleSize,
  intervalsDays: [...(cohort.samples || [])],
  averageIntervalDays: cohort.level === "system_default" ? null : cohort.intervalDays,
  minimumIntervalDays: cohort.samples?.length ? Math.min(...cohort.samples) : null,
  maximumIntervalDays: cohort.samples?.length ? Math.max(...cohort.samples) : null,
});

const capacityAssessmentFor = ({ roomSizeSqm, capacityHp }) => {
  const room = Number(roomSizeSqm || 0);
  const hp = Number(capacityHp || 0);
  if (!Number.isFinite(room) || room <= 0) return { status: "room_size_required", summary: "Room size information is required to evaluate AC capacity." };
  if (!Number.isFinite(hp) || hp <= 0) return { status: "capacity_required", summary: "AC horsepower information is required to evaluate cooling capacity." };
  const expectedRoomSize = hp * 14;
  const ratio = room / expectedRoomSize;
  const basis = " This is an approximate room-size comparison using the system's 14 m² per HP rule, not a measured cooling-load assessment.";
  if (ratio > 1.25) return { status: "insufficient", summary: "AC horsepower may be insufficient for the provided room size." + basis };
  if (ratio < 0.6) return { status: "higher_than_necessary", summary: "AC horsepower may be higher than necessary for the provided room size." + basis };
  return { status: "suitable", summary: "AC horsepower appears appropriate for the provided room size." + basis };
};

const cleaningMethodForDates = ({ lastCleaningDate, installationDate, asOfDate = new Date() } = {}) => {
  const reference = asDate(lastCleaningDate) || asDate(installationDate);
  if (!reference) return "";
  const referenceDate = startOfUtcDay(reference);
  const oneYearAnniversary = new Date(referenceDate.getTime());
  oneYearAnniversary.setUTCFullYear(oneYearAnniversary.getUTCFullYear() + 1);
  return startOfUtcDay(asOfDate) > oneYearAnniversary
    ? "deep_cleaning"
    : "regular_cleaning";
};

const calculateMaintenanceRecommendation = async (unitId, options = {}) => {
  const unit = await Unit.findById(unitId);
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }
  const calculationDate = asDate(options.asOfDate || new Date());
  if (!calculationDate) { const error = new Error("Enter a valid calculation date."); error.status = 400; throw error; }
  const asOfDate = startOfUtcDay(calculationDate);
  const allHistory = await ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).lean();
  const ownHistory = allHistory.filter((history) => assessServiceEvidence(history, { asOfDate: calculationDate, installedAt: unit.installation?.installedAt }).eligible);
  const serviceRequests = options.serviceRequests !== undefined
    ? options.serviceRequests
    : await ServiceRequest.find({ unitId: String(unit._id), status: { $ne: "Cancelled" } })
      .select("issue issueType payload status createdAt").sort({ createdAt: -1 }).lean();
  const maintenanceSignals = maintenanceSignalsFor(ownHistory, serviceRequests);
  const ownSamples = intervalSamplesForUnits([unit], ownHistory, calculationDate);
  let cohort;
  if (ownSamples.length >= MIN_HISTORICAL_SAMPLES) {
    cohort = selectHistoricalCohort([{ level: "same_unit", units: [unit], samples: ownSamples }]);
  } else if (maintenanceSignals.completedServiceCount === 0) {
    // A newly registered unit has no real operating history. Similar-unit data
    // may be useful context later, but it must not replace the stated six-month
    // starting schedule for this unit.
    cohort = selectHistoricalCohort([]);
  } else {
    const cohortKey = `${normalize(unit.brand)}:${normalize(unit.modelName)}:${unit.capacityHp}:${unit.category}`;
    cohort = options.cohortCache?.get(cohortKey);
    if (!cohort) { cohort = await collectHistoricalCohort(unit, calculationDate); options.cohortCache?.set(cohortKey, cohort); }
  }
  const patternAnalysis = patternAnalysisFor(cohort);
  const newestFirst = ownHistory.slice().sort((left, right) => asDate(right.serviceDate) - asDate(left.serviceDate));
  const lastService = newestFirst.find((history) => normalizeServiceType(history) !== "installation") || null;
  const lastCleaning = newestFirst.find((history) => ["regular_cleaning", "deep_cleaning"].includes(normalizeServiceType(history))) || null;
  const lastServiceDate = asDate(lastService?.serviceDate);
  const lastCleaningDate = asDate(lastCleaning?.serviceDate);
  const recordedInstallation = asDate(unit.installation?.installedAt);
  const installedAt = recordedInstallation && startOfUtcDay(recordedInstallation) <= asOfDate ? recordedInstallation : null;
  const anchor = lastCleaningDate || installedAt;
  const evidence = predictionEvidence({ unit, cohort,
    ownHistory: ownHistory.map(h => ({ ...h, normalizedType: normalizeServiceType(h) })),
    lastCleaningDate, installedAt, asOfDate, patternAnalysis, maintenanceSignals });
  const savedAi = unit.amp?.aiPrediction;
  const aiCurrent = savedPredictionIsCurrent(savedAi, evidence, calculationDate);
  const intervalDays = aiCurrent ? savedAi.prediction.interval_days : cohort.intervalDays;
  let bestServicedBy = anchor ? addCalendarMonths(startOfUtcDay(anchor), intervalDays) : null;
  let recommendedService = cleaningMethodForDates({
    lastCleaningDate,
    installationDate: installedAt,
    asOfDate,
  });
  const capacityAssessment = capacityAssessmentFor(unit);
  let basis = aiCurrent ? predictionBasis(savedAi.prediction, evidence) : anchor ? basisText(cohort) : "A completed cleaning or installation date is needed before a servicing date can be suggested.";
  let predictionSource = aiCurrent ? "openai" : "system";
  const routineMaintenance = {
    bestServicedBy: bestServicedBy?.toISOString() || null,
    recommendedService,
    recommendationBasis: basis,
    predictionSource,
    intervalDays,
  };
  const visitFollowUp = unit.amp?.visitFollowUp?.toObject?.() || unit.amp?.visitFollowUp || null;
  const latestCompletedVisit = newestFirst.find((history) => normalizeServiceType(history) !== "installation") || null;
  const visitFollowUpIsCurrent = Boolean(visitFollowUp?.provider === "openai"
    && visitFollowUp.sourceServiceHistoryId
    && String(visitFollowUp.sourceServiceHistoryId) === String(latestCompletedVisit?._id || "")
    && asDate(visitFollowUp.recommendedDate));
  if (visitFollowUpIsCurrent) {
    bestServicedBy = startOfUtcDay(visitFollowUp.recommendedDate);
    recommendedService = visitFollowUp.recommendedService || recommendedService;
    basis = visitFollowUp.customerSummary || "Follow-up timing is based on the technician's completed report and the AC unit's recorded history.";
    predictionSource = "openai";
  }
  const excludedRecordCount = allHistory.length - ownHistory.length;
  const dataQuality = { excludedRecordCount, message: excludedRecordCount ? `${excludedRecordCount} service record(s) have missing details or invalid dates and are excluded from maintenance timing. Ask the service team to review them.` : "", anchorType: lastCleaningDate ? "last_cleaning" : installedAt ? "installation" : "missing" };

  if (options.persist !== false) {
    unit.amp = {
      ...(unit.amp?.toObject?.() || unit.amp || {}),
      bestServicedBy,
      recommendedService,
      recommendationBasis: basis,
      basisLevel: cohort.level,
      intervalDays,
      predictionSource,
      baseIntervalDays: cohort.intervalDays,
      comparableSampleSize: cohort.sampleSize,
      patternAnalysis,
      maintenanceSignals,
      lastServiceDate,
      lastCleaningDate,
      capacityAssessment,
      nextIdealServiceDate: bestServicedBy,
      nextIdealServicePeriod: bestServicedBy ? `Suggested servicing date: ${bestServicedBy.toISOString().slice(0, 10)}` : "Installation or cleaning date required",
      lastCalculatedAt: new Date(),
      dataQuality,
      routineMaintenance: {
        bestServicedBy: routineMaintenance.bestServicedBy,
        recommendedService: routineMaintenance.recommendedService,
        recommendationBasis: routineMaintenance.recommendationBasis,
        predictionSource: routineMaintenance.predictionSource,
        intervalDays: routineMaintenance.intervalDays,
      },
    };
    if (["active", "service_due"].includes(unit.status) && bestServicedBy) unit.status = bestServicedBy < asOfDate ? "service_due" : "active";
    await unit.save();
  }

  return {
    unitId: String(unit._id),
    serialNumber: unit.serialNumber,
    brand: unit.brand,
    model: unit.modelName,
    category: unit.category || "",
    capacityHp: unit.capacityHp || 0,
    roomSizeSqm: unit.roomSizeSqm || null,
    bestServicedBy: bestServicedBy?.toISOString() || null,
    best_serviced_by: bestServicedBy?.toISOString() || null,
    recommendedService,
    recommended_service: recommendedService,
    lastServiceDate: lastServiceDate?.toISOString() || null,
    lastCleaningDate: lastCleaningDate?.toISOString() || null,
    recommendationBasis: basis,
    predictionSource,
    predictionEvidence: evidence,
    aiPrediction: aiCurrent ? { model: savedAi.model, generatedAt: savedAi.generatedAt, engineVersion: savedAi.engineVersion } : null,
    latestVisitAnalysis: visitFollowUpIsCurrent ? visitFollowUp : null,
    conditionBasedFollowUp: visitFollowUpIsCurrent && visitFollowUp.recommendationMode === "condition_based" ? visitFollowUp : null,
    routineMaintenance,
    historicalBasis: {
      level: cohort.level,
      intervalDays,
      baseIntervalDays: cohort.intervalDays,
      sampleSize: cohort.sampleSize,
      comparableUnitCount: cohort.comparableUnitCount,
      calculation: patternAnalysis.calculation,
      intervalsDays: patternAnalysis.intervalsDays,
    },
    patternAnalysis,
    maintenanceSignals,
    capacityAssessment,
    dataQuality,
    overdue: Boolean(bestServicedBy && bestServicedBy < asOfDate),
    generatedAt: new Date().toISOString(),
  };
};

const refreshMaintenanceRecommendations = async (query = {}, asOfDate = new Date()) => {
  const units = await Unit.find({ ...query, status: { $in: ["active", "service_due"] } }).select("_id").lean();
  const unitIds = units.map(unit => String(unit._id));
  const requests = unitIds.length ? await ServiceRequest.find({ unitId: { $in: unitIds }, status: { $ne: "Cancelled" } })
    .select("unitId issue issueType payload status createdAt").sort({ createdAt: -1 }).lean() : [];
  const requestsByUnit = new Map();
  requests.forEach(request => requestsByUnit.set(String(request.unitId), [...(requestsByUnit.get(String(request.unitId)) || []), request]));
  const cohortCache = new Map();
  for (const unit of units) await calculateMaintenanceRecommendation(unit._id, { asOfDate, cohortCache, serviceRequests: requestsByUnit.get(String(unit._id)) || [] });
};

module.exports = {
  DEFAULT_SERVICE_INTERVAL_DAYS,
  average,
  calculateMaintenanceRecommendation,
  capacityAssessmentFor,
  cleaningMethodForDates,
  normalizeServiceType,
  selectHistoricalCohort,
  intervalSamplesForUnits,
  refreshMaintenanceRecommendations,
};
