const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { calculateMaintenanceRecommendation } = require("./ampMaintenanceService");
const { appendWarrantyEvent, effectiveWarrantyStatus } = require("./warrantyService");
const { isDetailedFinding, detailedActions } = require("./serviceEvidence");
const { formatDateKeyInTimeZone } = require("../utils/dateTime");
const { callStructuredAmpAnalysis } = require("../services/openAiAmpService");
const { buildVisitEvidence, finalizeVisitAnalysis } = require("./ampVisitAnalysis");
const { serviceCosts, validateServiceCosts } = require("./serviceCosts");

const AI_ANALYSIS_MAX_ATTEMPTS = 3;
const AI_RETRY_DELAYS_MS = [15 * 60 * 1000, 6 * 60 * 60 * 1000];

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

const validateStrictServicePayload = (payload = {}) => {
  const errors = {};
  const serviceType = resolveExplicitServiceType(payload);
  const findings = clean(payload.findings || payload.notes || payload.proof_notes, 1000);
  const actions = list(payload.service_actions || payload.serviceActions || payload.action_taken || payload.resolution);
  const conditionRating = clean(payload.condition_rating || payload.conditionRating).toLowerCase();
  const serviceDate = new Date(payload.service_date || payload.serviceDate || new Date());

  if (!serviceType) errors.serviceType = "Choose the service type performed.";
  if (!isDetailedFinding(findings)) errors.findings = "Record actual technician findings using at least 10 characters. A service recommendation is not a finding.";
  if (!detailedActions(actions).length) errors.serviceActions = "Describe the work performed. 'Service completed' alone is not a service report.";
  if (!["excellent", "good", "fair", "poor"].includes(conditionRating)) {
    errors.conditionRating = "Choose excellent, good, fair, or poor for the unit condition.";
  }
  if (Number.isNaN(serviceDate.getTime())) errors.serviceDate = "Enter a valid service date.";
  else if (serviceDate > new Date()) errors.serviceDate = "Completed service cannot have a future date or time.";

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: { serviceType, findings, actions, conditionRating, serviceDate },
  };
};

const analyzeCompletedVisit = async ({
  unit,
  serviceHistory,
  recommendation,
  technicianId,
  providerCall = callStructuredAmpAnalysis,
  recalculate = calculateMaintenanceRecommendation,
}) => {
  if (serviceHistory.aiInterpretation?.status === "completed" && Number(serviceHistory.aiInterpretation?.analysisVersion || 0) >= 4) {
    return { interpretation: serviceHistory.aiInterpretation, recommendation };
  }
  const priorHistory = await ServiceHistory.find({ unit: unit._id, _id: { $ne: serviceHistory._id } })
    .sort({ serviceDate: -1 }).limit(8).lean();
  const evidence = buildVisitEvidence({ unit, serviceHistory, priorHistory, recommendation });
  let providerResult;
  try {
    providerResult = await providerCall({
      safetyIdentifier: String(technicianId || "technician-visit"),
      recommendation,
      visitAnalysis: true,
      visitEvidence: evidence,
    });
  } catch (error) {
    providerResult = { provider: "system-fallback", insight: null, error: "AI analysis could not be completed. The technician's original report remains available." };
  }
  const interpretation = finalizeVisitAnalysis({ providerResult, evidence, recommendation, serviceHistory });
  const analysisAttempts = Number(serviceHistory.aiInterpretation?.analysisAttempts || 0) + 1;
  const lastAnalysisAttemptAt = new Date();
  interpretation.analysisAttempts = analysisAttempts;
  interpretation.lastAnalysisAttemptAt = lastAnalysisAttemptAt;
  interpretation.nextAnalysisAttemptAt = interpretation.provider !== "openai" && analysisAttempts < AI_ANALYSIS_MAX_ATTEMPTS
    ? new Date(lastAnalysisAttemptAt.getTime() + AI_RETRY_DELAYS_MS[Math.min(analysisAttempts - 1, AI_RETRY_DELAYS_MS.length - 1)])
    : null;
  serviceHistory.aiInterpretation = interpretation;
  await serviceHistory.save();

  if (interpretation.provider === "openai" && interpretation.recommendedFollowUpDate) {
    await Unit.updateOne({ _id: unit._id }, { $set: {
      "amp.visitFollowUp": {
        analysisVersion: interpretation.analysisVersion,
        sourceServiceHistoryId: String(serviceHistory._id),
        provider: "openai",
        severity: interpretation.severity,
        riskType: interpretation.riskType,
        predictedRisk: interpretation.predictedRisk,
        affectedComponent: interpretation.affectedComponent,
        evidenceConfidence: interpretation.evidenceConfidence,
        recommendationMode: interpretation.recommendationMode,
        recommendedService: interpretation.recommendedService,
        recommendedFollowUpDays: interpretation.recommendedFollowUpDays,
        recommendedDate: interpretation.recommendedFollowUpDate,
        aiAssessment: interpretation.aiAssessment,
        whyThisDate: interpretation.whyThisDate,
        customerSummary: interpretation.customerSummary,
        recommendedActions: interpretation.recommendedActions,
        generatedAt: interpretation.generatedAt,
      },
    } });
    recommendation = await recalculate(unit._id);
  }
  return { interpretation, recommendation };
};

const completeServiceForUnit = async ({ unitId, technicianId, sourceTaskId, payload = {} }) => {
  const validation = validateStrictServicePayload(payload);
  if (!validation.ok) {
    const error = new Error("Complete the required technician service report.");
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

  const { serviceDate, serviceType, findings, actions, conditionRating } = validation.values;
  if (["retired", "on_hold"].includes(unit.status)) {
    const error = new Error("This AC unit is unavailable for service completion. Ask the branch team to review its status."); error.status = 409; throw error;
  }
  if (unit.installation?.installedAt && formatDateKeyInTimeZone(serviceDate) < formatDateKeyInTimeZone(unit.installation.installedAt)) {
    const error = new Error("A service date cannot precede the recorded installation date."); error.status = 400; throw error;
  }
  const partsUsed = list(payload.parts_used || payload.partsUsed);
  const normalizedCosts = {
    ...payload,
    serviceLogs: Array.isArray(payload.serviceLogs)
      ? payload.serviceLogs.map((entry) => ({ ...entry }))
      : payload.serviceLogs,
  };
  const costError = validateServiceCosts(normalizedCosts);
  if (costError) {
    const error = new Error(costError);
    error.status = 400;
    error.errors = { serviceCosts: costError };
    throw error;
  }
  const costs = serviceCosts(normalizedCosts);
  const latestLog = Array.isArray(normalizedCosts.serviceLogs)
    ? normalizedCosts.serviceLogs.filter((entry) => entry && typeof entry === "object")[0] || {}
    : {};
  const rawHoursSpent = payload.hoursSpent ?? payload.hours_spent ?? latestLog.hoursSpent;
  const hoursSpent = rawHoursSpent === "" || rawHoursSpent === null || rawHoursSpent === undefined
    ? null
    : Number(rawHoursSpent);
  if (hoursSpent !== null && (!Number.isFinite(hoursSpent) || hoursSpent <= 0 || hoursSpent > 1000)) {
    const error = new Error("Hours worked must be a positive number no greater than 1000.");
    error.status = 400;
    error.errors = { hoursSpent: error.message };
    throw error;
  }
  const technicianNotes = clean(
    payload.notes ?? payload.additionalNotes ?? latestLog.notes ?? latestLog.additionalNotes,
    1000,
  );
  const customerReportedIssue = clean(
    payload.customerObservation ?? payload.issueDescription ?? payload.concern,
    1000,
  );
  const customerNotes = clean(payload.customerNotes ?? payload.requestNotes, 1000);
  const customerOther = clean(payload.customerOther ?? payload.other ?? payload.otherIssue ?? payload.otherDescription, 1000);

  const historyData = {
    unit: unit._id,
    ...(sourceTaskId ? { sourceTaskId: String(sourceTaskId) } : {}),
    technician: technicianId,
    serviceDate,
    visitType: visitTypeFor(serviceType),
    serviceType,
    conditionRating,
    findings,
    actionTaken: actions.join(", "),
    partsUsed,
    hoursSpent,
    ...costs,
    technicianInputs: {
      notes: technicianNotes || findings,
    },
    customerInputs: {
      reportedIssue: customerReportedIssue,
      notes: customerNotes,
      other: customerOther,
    },
    serviceActions: actions,
  };
  const recordedResourceFields = Object.fromEntries(Object.entries({ hoursSpent, ...costs }).filter(([, value]) => value !== null));
  const historyInsertData = { ...historyData };
  Object.keys(recordedResourceFields).forEach((field) => delete historyInsertData[field]);
  const serviceHistory = sourceTaskId
    ? await ServiceHistory.findOneAndUpdate(
      { unit: unit._id, sourceTaskId: String(sourceTaskId) },
      { $setOnInsert: historyInsertData, $set: { ...recordedResourceFields, customerInputs: historyData.customerInputs } },
      { upsert: true, returnDocument: "after", runValidators: true },
    )
    : await ServiceHistory.create(historyData);
  let recommendation = await calculateMaintenanceRecommendation(unit._id);
  serviceHistory.ampSnapshot = {
    bestServicedBy: recommendation.bestServicedBy,
    recommendedService: recommendation.recommendedService,
    recommendationBasis: recommendation.recommendationBasis,
    nextIdealServiceDate: recommendation.bestServicedBy,
    nextIdealServicePeriod: recommendation.bestServicedBy ? `Suggested servicing date: ${recommendation.bestServicedBy.slice(0, 10)}` : "Date required",
    calculatedAt: new Date(),
  };
  await serviceHistory.save();

  const warranty = unit.warranty?.toObject?.() || unit.warranty || {};
  if (warranty?.startDate) {
    const claimId = clean(payload.warranty_claim_id || payload.warrantyClaimId);
    const claims = Array.isArray(warranty.claims) ? warranty.claims : [];
    const claimIndex = claimId ? claims.findIndex((claim) => String(claim?.claimId || "") === claimId) : -1;
    if (claimIndex >= 0 && ["approved", "service_completed"].includes(claims[claimIndex].status)) claims[claimIndex] = { ...claims[claimIndex], status: "service_completed", resolvedAt: claims[claimIndex].resolvedAt || new Date(), serviceHistoryId: String(serviceHistory._id) };
    warranty.claims = claims;
    const alreadyRecorded = (warranty.serviceRecords || []).some((entry) => String(entry.serviceHistoryId) === String(serviceHistory._id));
    warranty.serviceRecords = [
      ...(Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : []),
      ...(alreadyRecorded ? [] : [{ serviceDate, visitType: serviceType, summary: findings, serviceHistoryId: String(serviceHistory._id), claimId }]),
    ];
    warranty.status = effectiveWarrantyStatus(warranty);
    if (!alreadyRecorded) warranty.timeline = appendWarrantyEvent(
      warranty,
      claimIndex >= 0 ? "Warranty Service Completed" : "Warranty Service Record Added",
      claimIndex >= 0 ? "Approved warranty claim service was completed." : "Service history and AMP recommendation were updated.",
    );
    unit.warranty = warranty;
    await unit.save();
  }

  const analysis = await analyzeCompletedVisit({ unit, serviceHistory, recommendation, technicianId });
  recommendation = analysis.recommendation;
  serviceHistory.ampSnapshot = {
    bestServicedBy: recommendation.bestServicedBy,
    recommendedService: recommendation.recommendedService,
    recommendationBasis: recommendation.recommendationBasis,
    nextIdealServiceDate: recommendation.bestServicedBy,
    nextIdealServicePeriod: recommendation.bestServicedBy ? `Suggested servicing date: ${recommendation.bestServicedBy.slice(0, 10)}` : "Date required",
    calculatedAt: new Date(),
  };
  await serviceHistory.save();

  return { unit: await Unit.findById(unit._id), serviceHistory, recommendation, interpretation: analysis.interpretation };
};

module.exports = {
  AI_ANALYSIS_MAX_ATTEMPTS,
  analyzeCompletedVisit,
  completeServiceForUnit,
  validateStrictServicePayload,
};
