const Unit = require("../models/Unit");
const { calculate_next_service_date } = require("../domain/ampDecayService");
const {
  getManagerServicePipeline,
  getOwnerServiceForecast,
} = require("../domain/ampDashboardService");
const { completeServiceForUnit } = require("../domain/serviceCompletionService");

const INTERNAL_AMP_ROLES = new Set(["technician", "manager", "owner", "admin", "superadmin"]);

const serializeCustomerUnit = (unit) => {
  const json = unit.toJSON ? unit.toJSON() : unit;
  return {
    id: json.id || String(json._id || ""),
    userId: String(json.customer || ""),
    unitName: [json.brand, json.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
    brand: json.brand || "",
    model: json.modelName || "",
    serialNumber: json.serialNumber || "",
    qrCode: json.qrCode || "",
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

    return res.json({ units: units.map(serializeCustomerUnit) });
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
