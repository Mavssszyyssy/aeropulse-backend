const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { calculate_next_service_date } = require("../domain/ampDecayService");
const {
  getManagerServicePipeline,
  getOwnerServiceForecast,
} = require("../domain/ampDashboardService");
const { completeServiceForUnit } = require("../domain/serviceCompletionService");
const { effectiveWarrantyStatus } = require("../domain/warrantyService");

const INTERNAL_AMP_ROLES = new Set(["technician", "manager", "owner", "admin", "superadmin"]);

const getWarrantyRecommendation = (warranty = {}) => {
  const status = effectiveWarrantyStatus(warranty);
  const repairCount = (Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : [])
    .filter((record) => /repair/i.test(String(record?.visitType || ""))).length;

  if (status === "under_review") {
    return "Your warranty claim is under review. Keep the unit available for service inspection.";
  }
  if (status === "approved") {
    return "Warranty repair has been approved. Keep the scheduled technician appointment to complete the repair.";
  }
  if (status === "expired") {
    return "Warranty coverage has expired. Continue preventive maintenance and request a paid service quote if needed.";
  }
  if (repairCount >= 2) {
    return "Repeated warranty repairs were recorded. AMP recommends a full diagnostic inspection at the next service visit.";
  }
  return "Warranty is active. Use preventive maintenance records to protect coverage and AC health.";
};

const serializeCustomerUnit = (unit, serviceHistory = []) => {
  const json = unit.toJSON ? unit.toJSON() : unit;
  const warranty = { ...(json.warranty || {}) };
  warranty.status = effectiveWarrantyStatus(warranty);
  return {
    id: json.id || String(json._id || ""),
    userId: String(json.customer || ""),
    unitName: [json.brand, json.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
    brand: json.brand || "",
    model: json.modelName || "",
    serialNumber: json.serialNumber || "",
    qrCode: json.qrCode || "",
    qrUnitId: json.qrUnitId || "",
    serviceBranch: json.serviceBranch || "",
    status:
      json.status === "service_due"
        ? "Service Due"
        : json.status === "on_hold"
          ? "On Hold"
          : "Active",
    installationDate: json.installation?.installedAt
      ? new Date(json.installation.installedAt).toISOString().split("T")[0]
      : "",
    placementArea: json.installation?.addressLine || "",
    installationEnvironment: [
      json.installation?.city,
      json.installation?.province,
      json.installation?.zipCode,
    ]
      .filter(Boolean)
      .join(", "),
    usageLevel: "Normal",
    ventilationQuality: "Good",
    lastMaintenanceDate: "",
    amp: json.amp || {},
    warranty: {
      ...warranty,
      claims: Array.isArray(warranty.claims) ? warranty.claims : [],
      serviceRecords: Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : [],
      timeline: Array.isArray(warranty.timeline) ? warranty.timeline : [],
    },
    warrantyStatus: warranty.status || "pending_activation",
    warrantyExpirationDate: warranty.expirationDate || "",
    warrantyRecommendation: getWarrantyRecommendation(warranty),
    serviceHistory: serviceHistory.map((service) => ({
      id: String(service._id || service.id || ""),
      date: service.serviceDate,
      serviceType: service.visitType,
      details: service.technicianInputs?.notes || "Service completed",
      conditionRating: service.conditionRating,
    })),
    nextIdealServiceDate: json.amp?.nextIdealServiceDate || "",
    nextIdealServicePeriod: json.amp?.nextIdealServicePeriod || "",
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };
};

const assertUnitAccess = async (req) => {
  if (INTERNAL_AMP_ROLES.has(req.authUser.role)) return;

  const unit = await Unit.findById(req.params.unitId).select("customer");
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }

  if (String(unit.customer || "") !== String(req.authUser._id || "")) {
    const error = new Error("Forbidden");
    error.status = 403;
    throw error;
  }
};

const calculateNextServiceDate = async (req, res) => {
  try {
    await assertUnitAccess(req);
    const result = await calculate_next_service_date(req.params.unitId, {
      asOfDate: req.query.asOfDate,
      lookbackDays: req.query.lookbackDays,
      persist: req.query.persist !== "false",
    });

    return res.json(result);
  } catch (error) {
    console.error("Failed to calculate AMP next service date:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to calculate next ideal service period.",
    });
  }
};

const listMyUnits = async (req, res) => {
  try {
    if (req.authUser.role !== "customer") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const units = await Unit.find({
      customer: req.authUser._id,
      status: { $ne: "retired" },
    }).sort({ updatedAt: -1 });

    const histories = units.length
      ? await ServiceHistory.find({ unit: { $in: units.map((unit) => unit._id) } })
        .sort({ serviceDate: -1 })
        .limit(500)
      : [];
    const historyByUnit = new Map();
    histories.forEach((history) => {
      const key = String(history.unit || "");
      const current = historyByUnit.get(key) || [];
      current.push(history);
      historyByUnit.set(key, current);
    });

    return res.json({
      units: units.map((unit) => serializeCustomerUnit(unit, historyByUnit.get(String(unit._id)) || [])),
    });
  } catch (error) {
    console.error("Failed to list customer AMP units:", error);
    return res.status(500).json({
      message: "Unable to load installed AC units right now.",
    });
  }
};

const completeService = async (req, res) => {
  try {
    const result = await completeServiceForUnit({
      unitId: req.params.unitId,
      technicianId: req.authUser._id,
      payload: req.body || {},
    });

    return res.status(201).json({
      serviceHistory: result.serviceHistory.toJSON(),
      baselineHealthScore: result.baselineHealthScore,
      next_ideal_service_date: result.nextIdealServiceDate,
      next_ideal_service_period: result.nextIdealServicePeriod,
      unit: result.unit.toJSON(),
    });
  } catch (error) {
    console.error("Failed to complete service:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to complete service.",
      errors: error.errors || null,
    });
  }
};

const getManagerPipeline = async (req, res) => {
  try {
    const result = await getManagerServicePipeline({
      days: req.query.days,
      branch: req.authUser.role === "superadmin" ? "" : req.activeBranch,
    });
    return res.json(result);
  } catch (error) {
    console.error("Failed to load AMP manager pipeline:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to load AMP service pipeline.",
    });
  }
};

const getOwnerForecast = async (req, res) => {
  try {
    const result = await getOwnerServiceForecast({
      months: req.query.months,
      averageRevenue: req.query.averageRevenue,
    });
    return res.json(result);
  } catch (error) {
    console.error("Failed to load AMP owner forecast:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to load AMP owner forecast.",
    });
  }
};

module.exports = {
  listMyUnits,
  calculateNextServiceDate,
  completeService,
  getManagerPipeline,
  getOwnerForecast,
};
