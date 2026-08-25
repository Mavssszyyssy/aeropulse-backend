const mongoose = require("mongoose");
const Product = require("../models/Product");
const ServiceHistory = require("../models/ServiceHistory");
const Unit = require("../models/Unit");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SERVICE_INTERVAL_DAYS = 270;
const MIN_HISTORICAL_SAMPLES = 2;

const asDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const startOfUtcDay = (value = new Date()) => {
  const date = asDate(value) || new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const addDays = (date, days) => new Date(date.getTime() + Number(days || 0) * MS_PER_DAY);
const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalize = (value) => String(value || "").trim().toLowerCase();

const median = (values = [], fallback = DEFAULT_SERVICE_INTERVAL_DAYS) => {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 30 && value <= 730).sort((a, b) => a - b);
  if (!valid.length) return fallback;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : Math.round((valid[middle - 1] + valid[middle]) / 2);
};

const normalizeServiceType = (history = {}) => {
  const explicit = normalize(history.serviceType);
  if (["regular_cleaning", "deep_cleaning", "repair", "inspection", "installation"].includes(explicit)) return explicit;
  const source = normalize(`${history.visitType || ""} ${history.actionTaken || ""} ${(history.serviceActions || []).join(" ")}`);
  if (source.includes("deep") || source.includes("overhaul") || source.includes("disassembl")) return "deep_cleaning";
  if (source.includes("repair") || source.includes("replace")) return "repair";
  if (source.includes("inspection")) return "inspection";
  if (source.includes("installation")) return "installation";
  return "regular_cleaning";
};

const serviceDatesFor = (histories = []) => histories
  .filter((history) => normalizeServiceType(history) !== "installation")
  .map((history) => asDate(history.serviceDate))
  .filter(Boolean)
  .sort((a, b) => a.getTime() - b.getTime());

const intervalSamplesForUnits = (units = [], histories = []) => {
  const historyByUnit = new Map();
  histories.forEach((history) => {
    const key = String(history.unit || "");
    const current = historyByUnit.get(key) || [];
    current.push(history);
    historyByUnit.set(key, current);
  });

  const samples = [];
  units.forEach((unit) => {
    const dates = serviceDatesFor(historyByUnit.get(String(unit._id || unit.id)) || []);
    const installedAt = asDate(unit.installation?.installedAt);
    const anchors = installedAt && (!dates[0] || installedAt < dates[0]) ? [installedAt, ...dates] : dates;
    for (let index = 1; index < anchors.length; index += 1) {
      const interval = daysBetween(anchors[index - 1], anchors[index]);
      if (interval >= 30 && interval <= 730) samples.push(interval);
    }
  });
  return samples;
};

const resolveProductCategory = async (unit) => {
  if (unit.category) return normalize(unit.category);
  if (!mongoose.isValidObjectId(String(unit.productId || ""))) return "";
  const product = await Product.findById(unit.productId).select("category").lean();
  return normalize(product?.category);
};

const collectHistoricalCohort = async (unit) => {
  const category = await resolveProductCategory(unit);
  const allComparable = await Unit.find({
    _id: { $ne: unit._id },
    status: { $ne: "retired" },
  }).select("brand modelName capacityHp category installation.installedAt").limit(500).lean();

  const sameBrand = allComparable.filter((candidate) => normalize(candidate.brand) === normalize(unit.brand));
  const sameModel = sameBrand.filter((candidate) => normalize(candidate.modelName) === normalize(unit.modelName));
  const sameBrandType = sameBrand.filter((candidate) => {
    const categoryMatch = category && normalize(candidate.category) === category;
    const hp = Number(candidate.capacityHp || 0);
    const targetHp = Number(unit.capacityHp || 0);
    const capacityMatch = hp && targetHp && Math.abs(hp - targetHp) <= 0.5;
    return normalize(candidate.modelName) !== normalize(unit.modelName) && (categoryMatch || capacityMatch);
  });
  const similarCategory = allComparable.filter((candidate) => {
    if (!category || normalize(candidate.category) !== category) return false;
    const hp = Number(candidate.capacityHp || 0);
    const targetHp = Number(unit.capacityHp || 0);
    return !hp || !targetHp || Math.abs(hp - targetHp) <= 0.5;
  });

  const ids = allComparable.map((candidate) => candidate._id);
  const histories = ids.length
    ? await ServiceHistory.find({ unit: { $in: ids } }).sort({ serviceDate: 1 }).limit(5000).lean()
    : [];

  const samplesFor = (units) => intervalSamplesForUnits(units, histories);
  const levels = [
    { level: "same_model", units: sameModel, samples: samplesFor(sameModel) },
    { level: "same_brand_type", units: sameBrandType, samples: samplesFor(sameBrandType) },
    { level: "same_brand", units: sameBrand, samples: samplesFor(sameBrand) },
    { level: "similar_category", units: similarCategory, samples: samplesFor(similarCategory) },
  ];
  const selected = levels.find((item) => item.samples.length >= MIN_HISTORICAL_SAMPLES);
  if (selected) {
    return {
      level: selected.level,
      intervalDays: clamp(median(selected.samples), 90, 365),
      sampleSize: selected.samples.length,
      comparableUnitCount: selected.units.length,
      unitIds: selected.units.map((candidate) => candidate._id),
    };
  }
  return {
    level: "system_default",
    intervalDays: DEFAULT_SERVICE_INTERVAL_DAYS,
    sampleSize: 0,
    comparableUnitCount: 0,
    unitIds: [],
  };
};

const basisText = ({ level, intervalDays, sampleSize }) => {
  const months = Math.max(1, Math.round(intervalDays / 30));
  if (level === "same_model") return `Based on ${sampleSize} recorded service interval(s) from the same AC model, typically about ${months} month(s).`;
  if (level === "same_brand_type") return `Based on ${sampleSize} recorded service interval(s) from similar AC units of the same brand and type, typically about ${months} month(s).`;
  if (level === "same_brand") return `Based on ${sampleSize} recorded service interval(s) from the same AC brand, typically about ${months} month(s).`;
  if (level === "similar_category") return `Based on ${sampleSize} recorded service interval(s) from comparable AC units of the same type, typically about ${months} month(s).`;
  return "Based on the standard preventive-maintenance interval because limited comparable service history is currently available.";
};

const capacityAssessmentFor = ({ roomSizeSqm, capacityHp }) => {
  const room = Number(roomSizeSqm || 0);
  const hp = Number(capacityHp || 0);
  if (!room) return { status: "room_size_required", summary: "Room size information is required to evaluate AC capacity." };
  if (!hp) return { status: "capacity_required", summary: "AC horsepower information is required to evaluate cooling capacity." };
  const expectedRoomSize = hp * 14;
  const ratio = room / expectedRoomSize;
  if (ratio > 1.25) return { status: "insufficient", summary: "AC horsepower may be insufficient for the provided room size." };
  if (ratio < 0.6) return { status: "higher_than_necessary", summary: "AC horsepower may be higher than necessary for the provided room size." };
  return { status: "suitable", summary: "AC horsepower appears appropriate for the provided room size." };
};

const commonRecordedComponents = (histories = []) => {
  const counts = new Map();
  histories.forEach((history) => {
    const values = [
      ...(Array.isArray(history.partsUsed) ? history.partsUsed : []),
      ...(Array.isArray(history.serviceActions) ? history.serviceActions : []),
    ];
    values.forEach((value) => {
      const text = String(value || "").trim();
      if (!text) return;
      const normalized = normalize(text);
      const category = normalized.includes("board") || normalized.includes("pcb")
        ? "Board / Electronics"
        : normalized.includes("compressor") || normalized.includes("motor")
          ? "Compressor / Motor"
          : text;
      counts.set(category, (counts.get(category) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([component, count]) => ({ component, count }));
};

const calculateMaintenanceRecommendation = async (unitId, options = {}) => {
  const unit = await Unit.findById(unitId);
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }
  const asOfDate = startOfUtcDay(options.asOfDate || new Date());
  const ownHistory = await ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(200).lean();
  const cohort = await collectHistoricalCohort(unit);
  const lastService = ownHistory.find((history) => normalizeServiceType(history) !== "installation") || null;
  const lastCleaning = ownHistory.find((history) => ["regular_cleaning", "deep_cleaning"].includes(normalizeServiceType(history))) || null;
  const lastServiceDate = asDate(lastService?.serviceDate);
  const lastCleaningDate = asDate(lastCleaning?.serviceDate);
  const installedAt = asDate(unit.installation?.installedAt) || asOfDate;
  const anchor = lastServiceDate || installedAt;
  const bestServicedBy = addDays(startOfUtcDay(anchor), cohort.intervalDays);
  const cleaningReferenceDate = lastCleaningDate || lastServiceDate;
  const daysSinceCleaning = cleaningReferenceDate ? daysBetween(startOfUtcDay(cleaningReferenceDate), asOfDate) : null;
  const recommendedService = daysSinceCleaning !== null && daysSinceCleaning >= 365
    ? "deep_cleaning"
    : "regular_cleaning";
  const capacityAssessment = capacityAssessmentFor(unit);
  const basis = basisText(cohort);
  const similarHistories = cohort.unitIds.length
    ? await ServiceHistory.find({ unit: { $in: cohort.unitIds } }).sort({ serviceDate: -1 }).limit(1000).lean()
    : [];
  const commonComponents = commonRecordedComponents(similarHistories);

  if (options.persist !== false) {
    unit.amp = {
      ...(unit.amp?.toObject?.() || unit.amp || {}),
      bestServicedBy,
      recommendedService,
      recommendationBasis: basis,
      basisLevel: cohort.level,
      intervalDays: cohort.intervalDays,
      comparableSampleSize: cohort.sampleSize,
      lastServiceDate,
      lastCleaningDate,
      capacityAssessment,
      nextIdealServiceDate: bestServicedBy,
      nextIdealServicePeriod: `Best serviced by ${bestServicedBy.toLocaleDateString("en-US")}`,
      lastCalculatedAt: new Date(),
    };
    unit.status = bestServicedBy < asOfDate ? "service_due" : "active";
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
    bestServicedBy: bestServicedBy.toISOString(),
    best_serviced_by: bestServicedBy.toISOString(),
    recommendedService,
    recommended_service: recommendedService,
    lastServiceDate: lastServiceDate?.toISOString() || null,
    lastCleaningDate: lastCleaningDate?.toISOString() || null,
    recommendationBasis: basis,
    historicalBasis: {
      level: cohort.level,
      intervalDays: cohort.intervalDays,
      sampleSize: cohort.sampleSize,
      comparableUnitCount: cohort.comparableUnitCount,
    },
    capacityAssessment,
    commonComponents,
    overdue: bestServicedBy < asOfDate,
    generatedAt: new Date().toISOString(),
  };
};

module.exports = {
  DEFAULT_SERVICE_INTERVAL_DAYS,
  calculateMaintenanceRecommendation,
  capacityAssessmentFor,
  normalizeServiceType,
};
