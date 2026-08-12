const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { calculate_next_service_date } = require("./ampDecayService");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validateStrictServicePayload = (payload = {}) => {
  const errors = {};
  const visualWearRating = toNumber(payload.visual_wear_rating);
  const estimatedHoursUsed = toNumber(payload.estimated_hours_used);
  const refrigerantLevel = toNumber(payload.refrigerant_level);

  if (!Number.isFinite(visualWearRating) || visualWearRating < 1 || visualWearRating > 10) {
    errors.visual_wear_rating = "Visual wear rating is required and must be between 1 and 10.";
  }

  if (!Number.isFinite(estimatedHoursUsed) || estimatedHoursUsed < 0) {
    errors.estimated_hours_used = "Estimated hours used is required and must be 0 or greater.";
  }

  if (!Number.isFinite(refrigerantLevel) || refrigerantLevel < 0 || refrigerantLevel > 100) {
    errors.refrigerant_level = "Refrigerant level is required and must be between 0 and 100.";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      visualWearRating,
      estimatedHoursUsed,
      refrigerantLevel,
    },
  };
};

const conditionRatingFromBaseline = (score) => {
  if (score >= 90) return "excellent";
  if (score >= 78) return "good";
  if (score >= 64) return "fair";
  return "poor";
};

const deriveBaselineHealthScore = ({ visualWearRating, estimatedHoursUsed, refrigerantLevel }) => {
  // A completed service resets the baseline, but not blindly to 100.
  // The technician's discrete observations define the new starting point for future decay.
  const wearPenalty = (visualWearRating - 1) * 3.2;

  // High lifetime/period usage after service suggests harsher operation history.
  const usagePenalty =
    estimatedHoursUsed >= 6000 ? 8 :
    estimatedHoursUsed >= 3000 ? 5 :
    estimatedHoursUsed >= 1200 ? 2 :
    0;

  // Refrigerant below normal operating range is a strong reliability signal.
  const refrigerantPenalty =
    refrigerantLevel < 45 ? 18 :
    refrigerantLevel < 65 ? 10 :
    refrigerantLevel < 80 ? 4 :
    0;

  return Math.round(clamp(100 - wearPenalty - usagePenalty - refrigerantPenalty, 35, 100));
};

const completeServiceForUnit = async ({ unitId, technicianId, payload }) => {
  const validation = validateStrictServicePayload(payload);
  if (!validation.ok) {
    const error = new Error("Complete all required service fields before submitting.");
    error.status = 400;
    error.errors = validation.errors;
    throw error;
  }

  const unit = await Unit.findById(unitId);
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }

  const baselineHealthScore = deriveBaselineHealthScore(validation.values);

  const serviceHistory = await ServiceHistory.create({
    unit: unit._id,
    technician: technicianId,
    serviceDate: payload.service_date ? new Date(payload.service_date) : new Date(),
    visitType: "scheduled_service",
    baselineHealthScore,
    conditionRating: conditionRatingFromBaseline(baselineHealthScore),
    technicianInputs: {
      visualWearRating: validation.values.visualWearRating,
      estimatedHoursUsed: validation.values.estimatedHoursUsed,
      refrigerantLevel: validation.values.refrigerantLevel,
      usageHoursPerDay: toNumber(payload.usage_hours_per_day) ?? 8,
      filterCondition: payload.filter_condition || "normal",
      coilCondition: payload.coil_condition || "normal",
      drainageCondition: payload.drainage_condition || "clear",
      voltageStability: payload.voltage_stability || "stable",
      placementArea: payload.placement_area || "",
      notes: payload.notes || "",
    },
    serviceActions: Array.isArray(payload.service_actions)
      ? payload.service_actions.filter(Boolean)
      : [],
  });

  unit.amp.currentHealthScore = baselineHealthScore;
  unit.status = "active";
  await unit.save();

  const projection = await calculate_next_service_date(unit._id, {
    asOfDate: serviceHistory.serviceDate,
  });

  serviceHistory.ampSnapshot = {
    nextIdealServiceDate: projection.next_ideal_service_date,
    nextIdealServicePeriod: projection.next_ideal_service_period,
    calculatedAt: new Date(),
  };
  await serviceHistory.save();

  return {
    unit,
    serviceHistory,
    baselineHealthScore,
    nextIdealServiceDate: projection.next_ideal_service_date,
    nextIdealServicePeriod: projection.next_ideal_service_period,
  };
};

module.exports = {
  completeServiceForUnit,
  validateStrictServicePayload,
  deriveBaselineHealthScore,
};
