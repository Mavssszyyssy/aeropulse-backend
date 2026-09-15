const mongoose = require("mongoose");
const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { callStructuredAmpAnalysis, validateAmpInsight } = require("../services/openAiAmpService");
const { summarizeMajorComponentUse } = require("../domain/ampComponentCategories");
const { formatDateKeyInTimeZone } = require("../utils/dateTime");
const { assessServiceEvidence, serviceLabel, serviceTypeFor } = require("../domain/serviceEvidence");
const { effectiveWarrantyStatus } = require("../domain/warrantyService");
const { savePredictionSnapshot, loadPredictionReview } = require("../domain/maintenancePredictionReview");
const { assertAmpBranch } = require("../domain/ampAccess");
const { ENGINE_VERSION, validPrediction } = require("../domain/ampPrediction");
const { explanationForRecommendation } = require("../domain/ampCustomerExplanation");

const REPORT_TYPES = {
  predictive_maintenance: { label: "Next Maintenance Recommendation", filenameLabel: "Maintenance_Recommendation" },
  maintenance_summary: { label: "Maintenance Summary", filenameLabel: "Maintenance_Summary" },
  summary_report: { label: "Maintenance Summary", filenameLabel: "Maintenance_Summary" },
  inventory_reliability_analysis: { label: "Aggregate Recorded Service Analysis", filenameLabel: "Recorded_Service_Analysis" },
};
const AGGREGATE_ROLES = new Set(["admin", "superadmin", "owner", "manager"]);
const cleanText = (value, max = 300) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const slugSegment = (value, fallback) => cleanText(value, 80).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || fallback;
const displayService = serviceLabel;

async function resolveResponsibleBranch(req, unit, requestedBranch = "") {
  const routed = unit ? await resolvePreferredBranch({ city: unit.installation?.city || "", province: unit.installation?.province || "", street: unit.installation?.addressLine || "" }) : "";
  return cleanText(unit?.serviceBranch || req.activeBranch || req.authUser.activeBranch || req.authUser.assignedBranch || requestedBranch || routed || "AEROPULSE Central", 80);
}

const formatHistory = (item = {}) => ({
  date: item.serviceDate || "", type: serviceTypeFor(item), serviceLabel: serviceLabel(serviceTypeFor(item)),
  findings: cleanText(item.findings || item.technicianInputs?.notes || "", 500),
  actionTaken: cleanText(item.actionTaken || (item.serviceActions || []).join(", "), 500),
  partsUsed: Array.isArray(item.partsUsed) ? item.partsUsed.slice(0, 20) : [],
  technicianNotes: cleanText(item.technicianInputs?.notes || "", 500),
  customerObservations: [
    item.customerInputs?.reportedIssue,
    item.customerInputs?.notes,
    item.customerInputs?.other,
  ].map((value) => cleanText(value, 500)).filter(Boolean),
  evidence: assessServiceEvidence(item),
  aiInterpretation: item.aiInterpretation?.status ? item.aiInterpretation : null,
});

const addDistinct = (items, value, source) => {
  const text = cleanText(value, 500);
  if (!text || items.some((item) => item.value.toLowerCase() === text.toLowerCase())) return;
  items.push({ source, value: text });
};

const buildPredictiveAssessment = ({ unit, recommendation, history = [], requests = [] }) => {
  const factors = [];
  const observations = [];
  if (unit.brand) factors.push({ label: "AC brand", value: unit.brand });
  if (unit.modelName) factors.push({ label: "AC model", value: unit.modelName });
  if (unit.serialNumber) factors.push({ label: "Unit serial number", value: unit.serialNumber });
  if (unit.installation?.installedAt) factors.push({ label: "Installation date", value: unit.installation.installedAt });
  if (recommendation.lastServiceDate) factors.push({ label: "Last completed service", value: recommendation.lastServiceDate });
  if (recommendation.lastCleaningDate) factors.push({ label: "Last recorded cleaning", value: recommendation.lastCleaningDate });
  if (recommendation.historicalBasis?.sampleSize) factors.push({ label: "Verified cleaning intervals", value: String(recommendation.historicalBasis.sampleSize) });
  const latest = history.find((item) => serviceTypeFor(item) !== "installation");
  if (latest) {
    addDistinct(observations, latest.findings, "Technician finding");
    addDistinct(observations, latest.technicianInputs?.notes, "Technician comment");
    addDistinct(observations, latest.customerInputs?.reportedIssue, "Customer-reported concern");
    addDistinct(observations, latest.customerInputs?.notes, "Customer comment");
    addDistinct(observations, latest.customerInputs?.other, "Customer custom / Other input");
    if (latest.conditionRating) factors.push({ label: "Latest technician condition rating", value: latest.conditionRating });
    if (latest.serviceType) factors.push({ label: "Latest service type", value: serviceLabel(latest.serviceType) });
    if (latest.partsUsed?.length) factors.push({ label: "Parts recorded in latest visit", value: latest.partsUsed.join(", ") });
  }
  const latestRequest = requests[0];
  if (latestRequest) {
    addDistinct(observations, latestRequest.issue, "Customer-reported concern");
    addDistinct(observations, latestRequest.payload?.notes, "Customer comment");
    addDistinct(observations, latestRequest.payload?.other || latestRequest.payload?.otherIssue || latestRequest.payload?.otherDescription, "Customer custom / Other input");
  }
  const visit = recommendation.latestVisitAnalysis || {};
  const recommendedActions = Array.isArray(visit.recommendedActions) && visit.recommendedActions.length
    ? visit.recommendedActions.map((value) => cleanText(value, 500)).filter(Boolean)
    : recommendation.bestServicedBy
      ? [`Schedule ${serviceLabel(recommendation.recommendedService).toLowerCase()} by ${String(recommendation.bestServicedBy).slice(0, 10)}.`, "Review the original technician and customer observations before approving repair or replacement work."]
      : ["Record a valid installation date or completed cleaning report before setting a servicing schedule."];
  const severity = String(visit.severity || "").toLowerCase();
  const priority = ({ critical: "Immediate attention", urgent: "Urgent", soon: "Schedule soon", monitor: "Monitor", routine: "Routine" })[severity]
    || (recommendation.overdue ? "Schedule soon" : "Routine");
  return {
    recommendedServicingDate: recommendation.bestServicedBy || null,
    recommendedService: recommendation.recommendedService || "",
    assessmentSummary: recommendation.aiAssessment || visit.aiAssessment || recommendation.recommendationBasis || "Insufficient historical service data is available to establish a strong maintenance pattern.",
    factorsConsidered: factors,
    observationsConsidered: observations,
    relevantServiceHistory: history.filter((item) => serviceTypeFor(item) !== "installation").slice(0, 5).map(formatHistory),
    reasonForRecommendation: recommendation.whyThisDate || visit.whyThisDate || recommendation.recommendationBasis || "A completed cleaning or installation date is needed before a date can be calculated.",
    recommendedActions,
    priority,
    evidenceNotice: "Recorded facts, detected patterns, and recommendations are shown separately. A recommendation is not a confirmed mechanical diagnosis or booking.",
  };
};

const aggregateReliability = async (unit, branch) => {
  const query = { status: { $ne: "retired" } };
  if (branch && branch !== "AEROPULSE Central") query.serviceBranch = branch;
  if (unit?.brand) query.brand = unit.brand;
  const units = await Unit.find(query).select("brand modelName serialNumber serviceBranch installation.installedAt").lean();
  const installedDates = new Map(units.map((item) => [String(item._id), item.installation?.installedAt]));
  const ids = units.map((item) => item._id);
  const recorded = ids.length ? await ServiceHistory.find({ unit: { $in: ids } }).select("unit serviceType visitType findings actionTaken serviceActions partsUsed serviceDate").sort({ serviceDate: -1 }).lean() : [];
  const histories = recorded.filter((history) => assessServiceEvidence(history, { installedAt: installedDates.get(String(history.unit)) }).eligible && serviceTypeFor(history) !== "installation");
  const byModel = new Map();
  units.forEach((item) => byModel.set(String(item._id), `${item.brand || "Unknown"} ${item.modelName || "Unknown"}`.trim()));
  const serviceCounts = new Map();
  histories.forEach((item) => {
    const model = byModel.get(String(item.unit)) || "Unknown model"; serviceCounts.set(model, (serviceCounts.get(model) || 0) + 1);
  });
  return {
    scope: unit?.brand ? `${unit.brand} units at ${branch}` : branch,
    unitCount: units.length, recordedServiceCount: histories.length,
    modelsByRecordedService: Array.from(serviceCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([model, count]) => ({ model, count })),
    partsByRecordedUse: summarizeMajorComponentUse(histories),
    note: "Counts describe recorded history only and do not diagnose a specific AC unit.",
  };
};

const loadUnitAndRecommendation = async (req, unitId) => {
  assertAmpBranch(req);
  if (!mongoose.isValidObjectId(unitId)) { const error = new Error("Select a valid installed AC unit."); error.status = 400; throw error; }
  const unit = await Unit.findById(unitId);
  if (!unit) { const error = new Error("Installed AC unit not found."); error.status = 404; throw error; }
  if (req.authUser.role === "customer" && String(unit.customer || "") !== String(req.authUser._id || "")) { const error = new Error("You are not allowed to access this AC unit."); error.status = 403; throw error; }
  assertAmpBranch(req, unit);
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

// A fresh calculation rechecks the evidence after the provider round trip.
// Never apply a response based on a cleaning history that changed while waiting.
async function predictAndSave(req, unit, recommendation) {
  const ai = await callStructuredAmpAnalysis({ safetyIdentifier: String(req.authUser._id), recommendation, predictionMode: true });
  if (ai.provider !== "openai" || !validPrediction(ai.insight, recommendation.predictionEvidence)) return { ai, recommendation };
  const fresh = await calculateMaintenanceRecommendation(unit._id, { persist: false });
  if (fresh.predictionEvidence.fingerprint !== recommendation.predictionEvidence.fingerprint) {
    return { ai: { provider: "system-fallback", error: "Service history changed during prediction. Generate a new plan using the updated records." }, recommendation: await calculateMaintenanceRecommendation(unit._id) };
  }
  await Unit.updateOne({ _id: unit._id }, { $set: { "amp.aiPrediction": {
    engineVersion: ENGINE_VERSION, fingerprint: fresh.predictionEvidence.fingerprint,
    prediction: ai.insight, model: ai.model, requestId: ai.requestId, generatedAt: new Date().toISOString(),
  } } });
  const updated = await calculateMaintenanceRecommendation(unit._id);
  if (updated.predictionSource !== "openai") return { ai: { provider: "system-fallback", error: "The records changed before the estimate could be applied. Showing the current system schedule." }, recommendation: updated };
  return { ai, recommendation: updated };
}

const getMaintenanceRecommendation = async (req, res) => {
  try {
    const unitId = String(req.body?.unitId || req.body?.unit?.id || "");
    const loaded = await loadUnitAndRecommendation(req, unitId);
    const { ai, recommendation } = await predictAndSave(req, loaded.unit, loaded.recommendation);
    const [history, requests] = await Promise.all([
      ServiceHistory.find({ unit: loaded.unit._id }).sort({ serviceDate: -1 }).limit(20).lean(),
      ServiceRequest.find({ unitId: String(loaded.unit._id) }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    const predictiveAssessment = buildPredictiveAssessment({ unit: loaded.unit, recommendation, history, requests });
    return res.json({
      provider: ai.provider,
      recommendation: { ...recommendation, predictiveAssessment },
      insight: {
        best_serviced_by: recommendation.bestServicedBy?.slice(0, 10) || "", recommended_service: recommendation.recommendedService,
        recommendation_summary: recommendation.recommendationBasis, capacity_assessment: recommendation.capacityAssessment.status,
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
      return res.status(403).json({ message: "Aggregate recorded-service reports are available to authorized operations staff only." });
    }
    const loaded = await loadUnitAndRecommendation(req, String(req.body?.unitId || ""));
    const unit = loaded.unit;
    let recommendation = loaded.recommendation;
    let predictionResult = null;
    if (type === "predictive_maintenance") {
      const predicted = await predictAndSave(req, unit, recommendation);
      recommendation = predicted.recommendation;
      predictionResult = predicted.ai;
    }
    let predictionReviewWarning = "";
    if (type === "predictive_maintenance") {
      try { await savePredictionSnapshot(unit, recommendation); }
      catch { predictionReviewWarning = "The service plan could not be saved for later comparison. Generate it again before the visit."; }
    }
    const branch = await resolveResponsibleBranch(req, unit, req.body?.branch);
    const [history, requests, tasks] = await Promise.all([
      ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(50).lean(),
      ServiceRequest.find({ unitId: String(unit._id) }).sort({ createdAt: -1 }).limit(20).lean(),
      Task.find({ $or: [{ unitId: String(unit._id) }, { "payload.unitId": String(unit._id) }, { "payload.serialNumbers": unit.serialNumber }, { "payload.serialNumber": unit.serialNumber }, { "payload.items.serialNumbers": unit.serialNumber }, { "payload.items.serialUnits.serialNumber": unit.serialNumber }] }).sort({ updatedAt: -1 }).limit(20).lean(),
    ]);
    const aggregate = type === "inventory_reliability_analysis" ? await aggregateReliability(unit, branch) : null;
    let predictionReview = null;
    if (AGGREGATE_ROLES.has(req.authUser.role)) {
      try { predictionReview = await loadPredictionReview(unit, history); }
      catch { predictionReviewWarning = [predictionReviewWarning, "Saved-plan comparisons are temporarily unavailable."].filter(Boolean).join(" "); }
    }
    const ai = predictionResult || await callStructuredAmpAnalysis({
      safetyIdentifier: String(req.authUser._id),
      recommendation,
      recordedHistory: history.filter((item) => assessServiceEvidence(item, { installedAt: unit.installation?.installedAt }).eligible).map(formatHistory),
      aggregateReliability: aggregate,
      reportType: type,
    });
    const insight = !predictionResult && ai.insight ? validateAmpInsight(ai.insight, recommendation) : null;
    const customerExplanation = explanationForRecommendation(recommendation);
    const predictiveAssessment = buildPredictiveAssessment({ unit, recommendation: { ...recommendation, ...customerExplanation }, history, requests });
    const generatedAt = new Date().toISOString(); const date = formatDateKeyInTimeZone(generatedAt);
    const identifier = slugSegment(unit.serialNumber || unit.qrUnitId, "AC-UNIT");
    const fileIdentifier = aggregate ? `Branch-${slugSegment(branch, "AEROPULSE")}` : identifier;
    const fileNameBase = `AMP_${definition.filenameLabel}_${fileIdentifier}_${date}`;
    return res.json({
      provider: ai.provider,
      report: {
        reportType: type, reportLabel: definition.label,
        explanationWarning: ai.error || "",
        reportId: `AMP-${slugSegment(definition.filenameLabel, "REPORT").toUpperCase()}-${fileIdentifier}-${date.replaceAll("-", "")}`,
        title: definition.label, fileNameBase, fileName: `${fileNameBase}.pdf`, generatedAt,
        branch, preparedBy: "AEROPULSE system-generated report", systemName: "AEROPULSE", watermark: "AEROPULSE",
        unit: { unitId: String(unit._id), qrUnitId: unit.qrUnitId || "", serialNumber: unit.serialNumber, brand: unit.brand, model: unit.modelName, category: unit.category || "", capacityHp: unit.capacityHp || 0, roomSizeSqm: unit.roomSizeSqm || null, installedAt: unit.installation?.installedAt || null, serviceBranch: branch, warrantyStatus: effectiveWarrantyStatus(unit.warranty || {}) },
        maintenance: {
          predictionSource: recommendation.predictionSource, aiPrediction: recommendation.aiPrediction,
          bestServicedBy: recommendation.bestServicedBy, recommendedService: recommendation.recommendedService,
          lastServiceDate: recommendation.lastServiceDate, lastCleaningDate: recommendation.lastCleaningDate,
          recommendedServiceLabel: displayService(recommendation.recommendedService), recommendationBasis: recommendation.recommendationBasis,
          historicalBasis: recommendation.historicalBasis, capacityAssessment: recommendation.capacityAssessment,
          patternAnalysis: recommendation.patternAnalysis, maintenanceSignals: recommendation.maintenanceSignals,
          routineMaintenance: recommendation.routineMaintenance,
          latestVisitAnalysis: recommendation.latestVisitAnalysis,
          conditionBasedFollowUp: recommendation.conditionBasedFollowUp,
          dataQuality: recommendation.dataQuality, overdue: recommendation.overdue,
          aiAssessment: customerExplanation.aiAssessment,
          whyThisDate: customerExplanation.whyThisDate,
          predictiveAssessment,
          interpretation: insight?.recommendation_summary || recommendation.recommendationBasis,
        },
        serviceHistory: history.map((item) => ({ ...formatHistory(item), evidence: assessServiceEvidence(item, { installedAt: unit.installation?.installedAt }) })), serviceRequests: requests.map((item) => ({ date: item.createdAt, type: item.serviceType || item.issueType || "service", status: item.status || "", customerObservation: cleanText(item.issue || item.payload?.issueDescription, 500), customerNotes: cleanText(item.payload?.notes, 500), other: cleanText(item.payload?.other || item.payload?.otherIssue || item.payload?.otherDescription, 500) })),
        technicianTasks: tasks.map((item) => ({ date: item.completedAt || item.updatedAt, title: cleanText(item.title), status: item.status || "" })),
        aggregateReliability: aggregate,
        predictionReview, predictionReviewWarning,
        note: "This is a suggested maintenance schedule, not a confirmed booking or confirmed failure diagnosis. Condition follow-ups are limited to the technician's submitted findings and recorded history. Book a service visit in the Cold Air mobile app." + (ai.error ? ` ${ai.error}` : ""),
      },
    });
  } catch (error) {
    console.error("Failed to generate AMP report:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to generate the AMP report right now." });
  }
};

module.exports = { getMaintenanceRecommendation, generateAmpReport };
