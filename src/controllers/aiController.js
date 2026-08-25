const mongoose = require("mongoose");
const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { callStructuredAmpAnalysis, validateAmpInsight } = require("../services/openAiAmpService");

const REPORT_TYPES = {
  predictive_maintenance: { label: "Predictive Maintenance", filenameLabel: "Predictive_Maintenance" },
  maintenance_summary: { label: "Maintenance Summary", filenameLabel: "Maintenance_Summary" },
  summary_report: { label: "Maintenance Summary", filenameLabel: "Maintenance_Summary" },
  inventory_reliability_analysis: { label: "Aggregate Inventory Reliability Analysis", filenameLabel: "Inventory_Reliability" },
};
const AGGREGATE_ROLES = new Set(["admin", "superadmin", "owner", "manager"]);
const cleanText = (value, max = 300) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const slugSegment = (value, fallback) => cleanText(value, 80).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || fallback;
const displayService = (value) => value === "deep_cleaning" ? "Deep cleaning" : "Regular cleaning";

async function resolveResponsibleBranch(req, unit, requestedBranch = "") {
  if (req.authUser.role === "superadmin" && cleanText(requestedBranch)) return cleanText(requestedBranch, 80);
  const routed = unit ? await resolvePreferredBranch({ city: unit.installation?.city || "", province: unit.installation?.province || "", street: unit.installation?.addressLine || "" }) : "";
  return cleanText(unit?.serviceBranch || req.activeBranch || req.authUser.activeBranch || req.authUser.assignedBranch || requestedBranch || routed || "AEROPULSE Central", 80);
}

const formatHistory = (item = {}) => ({
  date: item.serviceDate || item.createdAt || "", type: item.serviceType || item.visitType || "service",
  findings: cleanText(item.findings || item.technicianInputs?.notes || "", 500),
  actionTaken: cleanText(item.actionTaken || (item.serviceActions || []).join(", "), 500),
  partsUsed: Array.isArray(item.partsUsed) ? item.partsUsed.slice(0, 20) : [],
});

const aggregateReliability = async (unit, branch) => {
  const query = { status: { $ne: "retired" } };
  if (branch && branch !== "AEROPULSE Central") query.serviceBranch = branch;
  if (unit?.brand) query.brand = unit.brand;
  const units = await Unit.find(query).select("brand modelName serialNumber serviceBranch").limit(500).lean();
  const ids = units.map((item) => item._id);
  const histories = ids.length ? await ServiceHistory.find({ unit: { $in: ids } }).select("unit serviceType visitType findings actionTaken partsUsed serviceDate").sort({ serviceDate: -1 }).limit(5000).lean() : [];
  const byModel = new Map();
  units.forEach((item) => byModel.set(String(item._id), `${item.brand || "Unknown"} ${item.modelName || "Unknown"}`.trim()));
  const serviceCounts = new Map(); const partCounts = new Map();
  histories.forEach((item) => {
    const model = byModel.get(String(item.unit)) || "Unknown model"; serviceCounts.set(model, (serviceCounts.get(model) || 0) + 1);
    (item.partsUsed || []).forEach((part) => { const name = cleanText(part, 100); if (name) partCounts.set(name, (partCounts.get(name) || 0) + 1); });
  });
  return {
    scope: unit?.brand ? `${unit.brand} units at ${branch}` : branch,
    unitCount: units.length, recordedServiceCount: histories.length,
    modelsByRecordedService: Array.from(serviceCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([model, count]) => ({ model, count })),
    partsByRecordedUse: Array.from(partCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([component, count]) => ({ component, count })),
    note: "Counts describe recorded history only and do not diagnose a specific AC unit.",
  };
};

const loadUnitAndRecommendation = async (req, unitId) => {
  if (!mongoose.isValidObjectId(unitId)) { const error = new Error("Select a valid installed AC unit."); error.status = 400; throw error; }
  const unit = await Unit.findById(unitId);
  if (!unit) { const error = new Error("Installed AC unit not found."); error.status = 404; throw error; }
  if (req.authUser.role === "customer" && String(unit.customer || "") !== String(req.authUser._id || "")) { const error = new Error("You are not allowed to access this AC unit."); error.status = 403; throw error; }
  if (req.authUser.role !== "superadmin" && req.authUser.role !== "customer" && req.activeBranch && unit.serviceBranch && unit.serviceBranch !== req.activeBranch) { const error = new Error("This AC unit belongs to another branch."); error.status = 403; throw error; }
  if (req.authUser.role === "technician") {
    const assignedTask = await Task.exists({
      assignedTechnicianId: String(req.authUser._id || ""),
      $or: [
        { unitId: String(unit._id) },
        { "payload.unitId": String(unit._id) },
        { "payload.serialNumbers": unit.serialNumber },
        { "payload.items.serialNumbers": unit.serialNumber },
        { "payload.items.serialUnits.serialNumber": unit.serialNumber },
      ],
    });
    if (!assignedTask) { const error = new Error("This AC unit is not part of one of your assigned work orders."); error.status = 403; throw error; }
  }
  return { unit, recommendation: await calculateMaintenanceRecommendation(unit._id) };
};

const getMaintenanceRecommendation = async (req, res) => {
  try {
    const unitId = String(req.body?.unitId || req.body?.unit?.id || "");
    const { unit, recommendation } = await loadUnitAndRecommendation(req, unitId);
    const history = await ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(50).lean();
    const ai = await callStructuredAmpAnalysis({ recommendation, recordedHistory: history.map(formatHistory) });
    return res.json({
      provider: ai.provider,
      recommendation,
      insight: ai.insight ? validateAmpInsight(ai.insight, recommendation) : {
        best_serviced_by: recommendation.bestServicedBy.slice(0, 10), recommended_service: recommendation.recommendedService,
        recommendation_summary: recommendation.recommendationBasis, capacity_assessment: recommendation.capacityAssessment.status,
        technician_preparation: recommendation.commonComponents.map((item) => item.component),
      },
      warning: ai.error || "", generatedAt: new Date().toISOString(),
    });
  } catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to generate the maintenance recommendation." }); }
};

const generateAmpReport = async (req, res) => {
  try {
    const type = String(req.body?.reportType || "predictive_maintenance").trim().toLowerCase();
    const definition = REPORT_TYPES[type];
    if (!definition) return res.status(400).json({ message: "Unsupported AMP report type." });
    if (type === "inventory_reliability_analysis" && !AGGREGATE_ROLES.has(req.authUser.role)) {
      return res.status(403).json({ message: "Aggregate inventory reliability reports are available to authorized operations staff only." });
    }
    const { unit, recommendation } = await loadUnitAndRecommendation(req, String(req.body?.unitId || ""));
    const branch = await resolveResponsibleBranch(req, unit, req.body?.branch);
    const [history, requests, tasks] = await Promise.all([
      ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(50).lean(),
      ServiceRequest.find({ unitId: String(unit._id) }).sort({ createdAt: -1 }).limit(20).lean(),
      Task.find({ $or: [{ unitId: String(unit._id) }, { "payload.serialNumbers": unit.serialNumber }, { "payload.serialNumber": unit.serialNumber }] }).sort({ updatedAt: -1 }).limit(20).lean(),
    ]);
    const aggregate = type === "inventory_reliability_analysis" ? await aggregateReliability(unit, branch) : null;
    const ai = await callStructuredAmpAnalysis({ recommendation, recordedHistory: history.map(formatHistory), aggregateReliability: aggregate });
    const insight = ai.insight ? validateAmpInsight(ai.insight, recommendation) : null;
    const generatedAt = new Date().toISOString(); const date = generatedAt.slice(0, 10);
    const identifier = slugSegment(unit.serialNumber || unit.qrUnitId, "AC-UNIT");
    const fileIdentifier = aggregate ? `Branch-${slugSegment(branch, "AEROPULSE")}` : identifier;
    const fileNameBase = `AMP_${definition.filenameLabel}_${fileIdentifier}_${date}`;
    return res.json({
      provider: ai.provider,
      report: {
        reportType: type, reportLabel: definition.label,
        reportId: `AMP-${slugSegment(definition.filenameLabel, "REPORT").toUpperCase()}-${fileIdentifier}-${date.replaceAll("-", "")}`,
        title: definition.label, fileNameBase, fileName: `${fileNameBase}.pdf`, generatedAt,
        branch, preparedBy: `${branch} Branch`, systemName: "AEROPULSE", watermark: "AEROPULSE",
        unit: { unitId: String(unit._id), qrUnitId: unit.qrUnitId || "", serialNumber: unit.serialNumber, brand: unit.brand, model: unit.modelName, category: unit.category || "", capacityHp: unit.capacityHp || 0, roomSizeSqm: unit.roomSizeSqm || null, installedAt: unit.installation?.installedAt || null, serviceBranch: branch, warrantyStatus: unit.warranty?.status || "" },
        maintenance: {
          bestServicedBy: recommendation.bestServicedBy, recommendedService: recommendation.recommendedService,
          lastServiceDate: recommendation.lastServiceDate, lastCleaningDate: recommendation.lastCleaningDate,
          recommendedServiceLabel: displayService(recommendation.recommendedService), recommendationBasis: recommendation.recommendationBasis,
          historicalBasis: recommendation.historicalBasis, capacityAssessment: recommendation.capacityAssessment,
          technicianPreparation: insight?.technician_preparation || recommendation.commonComponents.map((item) => item.component),
          interpretation: insight?.recommendation_summary || recommendation.recommendationBasis,
        },
        serviceHistory: history.map(formatHistory), serviceRequests: requests.map((item) => ({ date: item.createdAt, type: item.serviceType || item.issueType || "service", status: item.status || "" })),
        technicianTasks: tasks.map((item) => ({ date: item.completedAt || item.updatedAt, title: cleanText(item.title), status: item.status || "" })),
        aggregateReliability: aggregate,
        note: ai.error || "Prediction is decision support based on recorded history; final service findings require technician inspection.",
      },
    });
  } catch (error) {
    console.error("Failed to generate AMP report:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to generate the AMP report right now." });
  }
};

module.exports = { getMaintenanceRecommendation, generateAmpReport };
