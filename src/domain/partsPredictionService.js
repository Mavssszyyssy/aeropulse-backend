const ServiceHistory = require("../models/ServiceHistory");
const Unit = require("../models/Unit");

const clampProbability = (value) => Math.min(0.95, Math.max(0.05, value));

const buildPrediction = ({ partNumber, name, probability, reason }) => ({
  partNumber,
  name,
  probability: clampProbability(probability),
  reason,
});

const predictLikelyFailingParts = async ({ unitId }) => {
  const unit = await Unit.findById(unitId).lean();
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }

  const histories = await ServiceHistory.find({ unit: unit._id })
    .sort({ serviceDate: -1 })
    .limit(8)
    .lean();

  const latest = histories[0] || {};
  const inputs = latest.technicianInputs || {};
  const baseline = Number(latest.baselineHealthScore || unit.amp?.currentHealthScore || 100);
  const usageHours = Number(inputs.estimatedHoursUsed || inputs.usageHoursPerDay * 365 || 0);
  const predictions = [];

  if (inputs.refrigerantLevel !== undefined && Number(inputs.refrigerantLevel) < 70) {
    predictions.push(buildPrediction({
      partNumber: "AMP-REF-SEAL-KIT",
      name: "Refrigerant seal kit",
      probability: 0.78 + (70 - Number(inputs.refrigerantLevel)) / 100,
      reason: "Recent service history shows below-normal refrigerant level.",
    }));
  }

  if (["dusty", "clogged"].includes(inputs.filterCondition) || baseline < 75) {
    predictions.push(buildPrediction({
      partNumber: "AMP-FLTR-HIGHFLOW",
      name: "High-flow filter set",
      probability: inputs.filterCondition === "clogged" ? 0.88 : 0.72,
      reason: "Filter loading and baseline health indicate likely airflow restriction.",
    }));
  }

  if (["dusty", "iced"].includes(inputs.coilCondition) || unit.amp?.historicalCurveFactor > 1.15) {
    predictions.push(buildPrediction({
      partNumber: "AMP-COIL-CLEAN-PACK",
      name: "Evaporator coil cleaning pack",
      probability: inputs.coilCondition === "iced" ? 0.86 : 0.7,
      reason: "Coil condition history suggests higher fouling or icing risk.",
    }));
  }

  if (["slow", "blocked"].includes(inputs.drainageCondition)) {
    predictions.push(buildPrediction({
      partNumber: "AMP-DRAIN-PUMP",
      name: "Condensate drain pump or line kit",
      probability: inputs.drainageCondition === "blocked" ? 0.9 : 0.74,
      reason: "Drainage condition history indicates repeat blockage risk.",
    }));
  }

  if (["fluctuating", "unstable"].includes(inputs.voltageStability) || usageHours > 6000) {
    predictions.push(buildPrediction({
      partNumber: "AMP-CAP-RUN",
      name: "Run capacitor",
      probability: inputs.voltageStability === "unstable" ? 0.84 : 0.68,
      reason: "Voltage stress or high usage raises capacitor failure risk.",
    }));
  }

  return {
    unitId: String(unit._id),
    serialNumber: unit.serialNumber,
    generatedAt: new Date().toISOString(),
    parts: predictions
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5),
  };
};

module.exports = { predictLikelyFailingParts };
