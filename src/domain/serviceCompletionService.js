const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { calculateMaintenanceRecommendation } = require("./ampMaintenanceService");
const { appendWarrantyEvent, effectiveWarrantyStatus } = require("./warrantyService");

const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
const list = (value) => (Array.isArray(value) ? value : String(value || "").split(","))
  .map((item) => clean(item, 160))
  .filter(Boolean);

const resolveExplicitServiceType = (payload = {}) => {
  const value = clean(payload.service_type || payload.serviceType || payload.cleaning_type || payload.visit_type).toLowerCase().replace(/[\s-]+/g, "_");
  if (["regular_cleaning", "deep_cleaning", "repair", "inspection", "installation"].includes(value)) return value;
  return "";
};

const visitTypeFor = (serviceType) => {
  if (serviceType === "repair") return "repair";
  if (serviceType === "inspection") return "inspection";
  if (serviceType === "installation") return "installation";
  return "scheduled_service";
};

const completeServiceForUnit = async ({ unitId, technicianId, payload = {} }) => {
  const unit = await Unit.findById(unitId);
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }

  const serviceDate = payload.service_date || payload.serviceDate ? new Date(payload.service_date || payload.serviceDate) : new Date();
  if (Number.isNaN(serviceDate.getTime())) {
    const error = new Error("Enter a valid service date.");
    error.status = 400;
    throw error;
  }
  const explicitServiceType = resolveExplicitServiceType(payload);
  // When the work order does not explicitly describe the visit, use the
  // deterministic recommendation calculated from history before this new
  // service is recorded. This preserves the regular-vs-deep cleaning rule.
  const recommendationBeforeService = explicitServiceType
    ? null
    : await calculateMaintenanceRecommendation(unit._id, { asOfDate: serviceDate, persist: false });
  const serviceType = explicitServiceType || recommendationBeforeService.recommendedService || "regular_cleaning";
  const findings = clean(payload.findings || payload.notes || payload.proof_notes || "Service completed");
  const actions = list(payload.service_actions || payload.serviceActions || payload.action_taken || payload.resolution);
  const partsUsed = list(payload.parts_used || payload.partsUsed);

  const serviceHistory = await ServiceHistory.create({
    unit: unit._id,
    technician: technicianId,
    serviceDate,
    visitType: visitTypeFor(serviceType),
    serviceType,
    conditionRating: ["excellent", "good", "fair", "poor"].includes(clean(payload.condition_rating || payload.conditionRating).toLowerCase())
      ? clean(payload.condition_rating || payload.conditionRating).toLowerCase()
      : "good",
    findings,
    actionTaken: actions.join(", ") || "Service completed",
    partsUsed,
    technicianInputs: {
      usageHoursPerDay: Number(payload.usage_hours_per_day || payload.usageHoursPerDay || 8),
      filterCondition: clean(payload.filter_condition || payload.filterCondition || "normal").toLowerCase(),
      coilCondition: clean(payload.coil_condition || payload.coilCondition || "normal").toLowerCase(),
      drainageCondition: clean(payload.drainage_condition || payload.drainageCondition || "clear").toLowerCase(),
      voltageStability: clean(payload.voltage_stability || payload.voltageStability || "stable").toLowerCase(),
      placementArea: clean(payload.placement_area || payload.placementArea || unit.installation?.addressLine),
      notes: findings,
    },
    serviceActions: actions.length ? actions : ["Service completed"],
  });

  unit.status = "active";
  await unit.save();
  const recommendation = await calculateMaintenanceRecommendation(unit._id, { asOfDate: serviceDate });
  serviceHistory.ampSnapshot = {
    bestServicedBy: recommendation.bestServicedBy,
    recommendedService: recommendation.recommendedService,
    recommendationBasis: recommendation.recommendationBasis,
    nextIdealServiceDate: recommendation.bestServicedBy,
    nextIdealServicePeriod: `Best serviced by ${new Date(recommendation.bestServicedBy).toLocaleDateString("en-US")}`,
    calculatedAt: new Date(),
  };
  await serviceHistory.save();

  const warranty = unit.warranty?.toObject?.() || unit.warranty || {};
  if (warranty?.startDate) {
    const claimId = clean(payload.warranty_claim_id || payload.warrantyClaimId);
    const claims = Array.isArray(warranty.claims) ? warranty.claims : [];
    const claimIndex = claimId ? claims.findIndex((claim) => String(claim?.claimId || "") === claimId) : -1;
    if (claimIndex >= 0) claims[claimIndex] = { ...claims[claimIndex], status: "service_completed", resolvedAt: new Date(), serviceHistoryId: String(serviceHistory._id) };
    warranty.claims = claims;
    warranty.serviceRecords = [
      ...(Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : []),
      { serviceDate, visitType: serviceType, summary: findings, serviceHistoryId: String(serviceHistory._id), claimId },
    ];
    warranty.status = effectiveWarrantyStatus({ ...warranty, status: "active" });
    warranty.timeline = appendWarrantyEvent(
      warranty,
      claimIndex >= 0 ? "Warranty Service Completed" : "Warranty Service Record Added",
      claimIndex >= 0 ? "Approved warranty claim service was completed." : "Service history and AMP recommendation were updated.",
    );
    unit.warranty = warranty;
    await unit.save();
  }

  return { unit, serviceHistory, recommendation };
};

const validateStrictServicePayload = () => ({ ok: true, errors: {}, values: {} });

module.exports = { completeServiceForUnit, validateStrictServicePayload };
