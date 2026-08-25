const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { callStructuredAmpAnalysis, validateAmpInsight } = require("../services/openAiAmpService");
const { getManagerServicePipeline, getOwnerServiceForecast } = require("../domain/ampDashboardService");
const { completeServiceForUnit } = require("../domain/serviceCompletionService");
const { effectiveWarrantyStatus } = require("../domain/warrantyService");
const { createDedupedNotification } = require("../services/operationalNotificationService");

const INTERNAL_AMP_ROLES = new Set(["technician", "manager", "owner", "admin", "superadmin"]);
const displayService = (value) => value === "deep_cleaning" ? "Deep cleaning" : "Regular cleaning";

const getWarrantyRecommendation = (warranty = {}) => {
  const status = effectiveWarrantyStatus(warranty);
  if (status === "under_review") return "Your warranty claim is under review.";
  if (status === "approved") return "Warranty service is approved. Keep the scheduled appointment.";
  if (status === "expired") return "Warranty coverage has expired. Continue preventive maintenance.";
  return "Warranty is active. Keep completed service records to protect coverage.";
};

const serviceHistoryItem = (service) => ({
  id: String(service._id || service.id || ""),
  date: service.serviceDate,
  serviceType: service.serviceType || service.visitType || "service",
  findings: service.findings || service.technicianInputs?.notes || "",
  actionTaken: service.actionTaken || (service.serviceActions || []).join(", "),
  partsUsed: Array.isArray(service.partsUsed) ? service.partsUsed : [],
});

const serializeCustomerUnit = (unit, history = [], recommendation = null) => {
  const json = unit.toJSON ? unit.toJSON() : unit;
  const warranty = { ...(json.warranty || {}), status: effectiveWarrantyStatus(json.warranty || {}) };
  const bestServicedBy = recommendation?.bestServicedBy || json.amp?.bestServicedBy || json.amp?.nextIdealServiceDate || "";
  const recommendedService = recommendation?.recommendedService || json.amp?.recommendedService || "regular_cleaning";
  return {
    id: json.id || String(json._id || ""), userId: String(json.customer || ""),
    unitName: [json.brand, json.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
    brand: json.brand || "", model: json.modelName || "", category: json.category || "",
    capacityHp: Number(json.capacityHp || 0), roomSizeSqm: json.roomSizeSqm || null,
    serialNumber: json.serialNumber || "", qrCode: json.qrCode || "", qrUnitId: json.qrUnitId || "",
    serviceBranch: json.serviceBranch || "",
    status: json.status === "service_due" ? "Service Due" : json.status === "on_hold" ? "On Hold" : "Active",
    installationDate: json.installation?.installedAt ? new Date(json.installation.installedAt).toISOString().split("T")[0] : "",
    placementArea: json.installation?.addressLine || "",
    installationEnvironment: [json.installation?.city, json.installation?.province].filter(Boolean).join(", "),
    bestServicedBy, recommendedService, recommendedServiceLabel: displayService(recommendedService),
    lastServiceDate: recommendation?.lastServiceDate || json.amp?.lastServiceDate || null,
    lastCleaningDate: recommendation?.lastCleaningDate || json.amp?.lastCleaningDate || null,
    recommendationBasis: recommendation?.recommendationBasis || json.amp?.recommendationBasis || "",
    historicalBasis: recommendation?.historicalBasis || null,
    capacityAssessment: recommendation?.capacityAssessment || json.amp?.capacityAssessment || null,
    commonComponents: recommendation?.commonComponents || [], overdue: Boolean(recommendation?.overdue), amp: json.amp || {},
    warranty: { ...warranty, claims: Array.isArray(warranty.claims) ? warranty.claims : [], serviceRecords: Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : [], timeline: Array.isArray(warranty.timeline) ? warranty.timeline : [] },
    warrantyStatus: warranty.status || "pending_activation", warrantyExpirationDate: warranty.expirationDate || "",
    warrantyRecommendation: getWarrantyRecommendation(warranty), serviceHistory: history.map(serviceHistoryItem),
    createdAt: json.createdAt, updatedAt: json.updatedAt,
  };
};

const loadAccessibleUnit = async (req) => {
  const unit = await Unit.findById(req.params.unitId);
  if (!unit) { const error = new Error("Unit not found"); error.status = 404; throw error; }
  if (!INTERNAL_AMP_ROLES.has(req.authUser.role) && String(unit.customer || "") !== String(req.authUser._id || "")) {
    const error = new Error("Forbidden"); error.status = 403; throw error;
  }
  if (req.authUser.role !== "superadmin" && req.activeBranch && unit.serviceBranch && unit.serviceBranch !== req.activeBranch && req.authUser.role !== "customer") {
    const error = new Error("This unit belongs to another branch."); error.status = 403; throw error;
  }
  return unit;
};

const notifyDueMaintenance = async (unit, recommendation) => {
  if (!unit.customer || !recommendation.bestServicedBy) return;
  const due = new Date(recommendation.bestServicedBy);
  const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
  if (days > 30) return;
  const dateKey = due.toISOString().slice(0, 10);
  await createDedupedNotification({
    user: unit.customer, type: "service", category: "maintenance_due", severity: days < 0 ? "warning" : "info",
    title: days < 0 ? "AC maintenance is overdue" : "Upcoming AC maintenance",
    message: `${displayService(recommendation.recommendedService)} is recommended by ${due.toLocaleDateString("en-US")}.`,
    route: `/customer/units/${unit._id}`, targetId: String(unit._id), targetType: "unit",
    dedupeKey: `amp-due:${unit._id}:${dateKey}`,
  }, { dedupeMinutes: 24 * 60 });
};

const calculateNextServiceDate = async (req, res) => {
  try {
    const unit = await loadAccessibleUnit(req);
    const recommendation = await calculateMaintenanceRecommendation(unit._id, { asOfDate: req.query.asOfDate, persist: req.query.persist !== "false" });
    const history = await ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(50).lean();
    const ai = await callStructuredAmpAnalysis({ recommendation, recordedHistory: history.map(serviceHistoryItem) });
    const insight = ai.insight ? validateAmpInsight(ai.insight, recommendation) : {
      best_serviced_by: recommendation.bestServicedBy.slice(0, 10), recommended_service: recommendation.recommendedService,
      recommendation_summary: recommendation.recommendationBasis, capacity_assessment: recommendation.capacityAssessment.status,
      technician_preparation: recommendation.commonComponents.map((item) => item.component),
    };
    await notifyDueMaintenance(unit, recommendation);
    return res.json({ provider: ai.provider, recommendation, insight, warning: ai.error || "" });
  } catch (error) {
    console.error("Failed to calculate AMP maintenance recommendation:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to calculate the maintenance recommendation." });
  }
};

const listMyUnits = async (req, res) => {
  try {
    const units = await Unit.find({ customer: req.authUser._id, status: { $ne: "retired" } }).sort({ updatedAt: -1 });
    const histories = units.length ? await ServiceHistory.find({ unit: { $in: units.map((unit) => unit._id) } }).sort({ serviceDate: -1 }).limit(500) : [];
    const historyByUnit = new Map();
    histories.forEach((item) => historyByUnit.set(String(item.unit), [...(historyByUnit.get(String(item.unit)) || []), item]));
    const recommendations = await Promise.all(units.map((unit) => calculateMaintenanceRecommendation(unit._id)));
    await Promise.all(units.map((unit, index) => notifyDueMaintenance(unit, recommendations[index]).catch(() => null)));
    return res.json({ units: units.map((unit, index) => serializeCustomerUnit(unit, historyByUnit.get(String(unit._id)) || [], recommendations[index])) });
  } catch (error) {
    console.error("Failed to list customer AMP units:", error.message);
    return res.status(500).json({ message: "Unable to load installed AC units right now." });
  }
};

const updateRoomSize = async (req, res) => {
  try {
    const unit = await loadAccessibleUnit(req);
    const roomSizeSqm = Number(req.body?.roomSizeSqm);
    if (!Number.isFinite(roomSizeSqm) || roomSizeSqm <= 0 || roomSizeSqm > 10000) return res.status(400).json({ message: "Enter a valid room size in square meters." });
    unit.roomSizeSqm = roomSizeSqm; await unit.save();
    const recommendation = await calculateMaintenanceRecommendation(unit._id);
    return res.json({ message: "Room size saved.", recommendation, unit: serializeCustomerUnit(unit, [], recommendation) });
  } catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to update room size." }); }
};

const completeService = async (req, res) => {
  try {
    const result = await completeServiceForUnit({ unitId: req.params.unitId, technicianId: req.authUser._id, payload: req.body || {} });
    return res.status(201).json({ serviceHistory: result.serviceHistory.toJSON(), recommendation: result.recommendation, unit: result.unit.toJSON() });
  } catch (error) {
    console.error("Failed to complete service:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to complete service.", errors: error.errors || null });
  }
};

const getManagerPipeline = async (req, res) => {
  try { return res.json(await getManagerServicePipeline({ days: req.query.days, branch: req.authUser.role === "superadmin" ? "" : req.activeBranch })); }
  catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to load the maintenance pipeline." }); }
};
const getReportUnits = async (req, res) => {
  try {
    const branch = req.authUser.role === "superadmin" || req.authUser.role === "owner" ? "" : req.activeBranch;
    const query = { status: { $ne: "retired" } };
    if (branch) query.serviceBranch = branch;
    const units = await Unit.find(query)
      .select("brand modelName serialNumber serviceBranch status")
      .sort({ serviceBranch: 1, modelName: 1, serialNumber: 1 })
      .limit(500)
      .lean();
    return res.json({
      units: units.map((unit) => ({
        unitId: String(unit._id),
        modelName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
        serialNumber: unit.serialNumber || "",
        branch: unit.serviceBranch || "Unassigned",
        status: unit.status || "active",
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to load AMP report units." });
  }
};
const getOwnerForecast = async (req, res) => {
  try { return res.json(await getOwnerServiceForecast({ months: req.query.months, averageRevenue: req.query.averageRevenue })); }
  catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to load the maintenance forecast." }); }
};

module.exports = { listMyUnits, calculateNextServiceDate, updateRoomSize, completeService, getManagerPipeline, getReportUnits, getOwnerForecast };
