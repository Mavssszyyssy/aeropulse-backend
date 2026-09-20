const Unit = require("../models/Unit");
const Product = require("../models/Product");
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
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TECHNICIAN_STATUSES = new Set(["for_repair", "for_further_inspection", "completed"]);
const normalizeTechnicianStatus = (value) => {
  const normalized = clean(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
  return TECHNICIAN_STATUSES.has(normalized) ? normalized : "";
};

// Stock is only shown when a technician recorded an exact part name or SKU
// that matches an active catalog item. A component inferred from a symptom is
// never treated as proof that a replacement item is in inventory.
const recordedPartsInventory = async ({ unit, partsUsed = [] } = {}) => {
  const parts = list(partsUsed).slice(0, 12);
  if (!parts.length) return {
    matches: [],
    message: "No exact replacement part number was recorded. Verify the compatible part during inspection before checking stock or approving replacement.",
  };
  const exact = parts.map((part) => new RegExp(`^${escapeRegex(part)}$`, "i"));
  const products = await Product.find({
    isActive: true,
    $or: [{ sku: { $in: exact } }, { name: { $in: exact } }],
  }).select("name sku stock branchStock").limit(12).lean();
  const branch = clean(unit?.serviceBranch, 120);
  const matches = products.map((product) => {
    const branchStock = branch && product.branchStock && Object.prototype.hasOwnProperty.call(product.branchStock, branch)
      ? Number(product.branchStock[branch]) : null;
    return {
      name: clean(product.name, 160),
      sku: clean(product.sku, 100),
      companyStock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : null,
      branchStock: Number.isFinite(branchStock) ? branchStock : null,
    };
  });
  if (!matches.length) return {
    matches,
    message: "No active inventory record exactly matches the technician-recorded part. Verify the part number and AC compatibility before ordering or approving replacement.",
  };
  const stockSummary = matches.map((item) => {
    const branchText = item.branchStock === null ? "branch quantity not recorded" : `branch quantity ${item.branchStock}`;
    const companyText = item.companyStock === null ? "company quantity not recorded" : `company quantity ${item.companyStock}`;
    return `${item.name || item.sku} (${item.sku || "SKU not recorded"}: ${branchText}; ${companyText})`;
  }).join("; ");
  return { matches, message: `Matching recorded inventory item(s): ${stockSummary}. Verify exact compatibility before approval.` };
};

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

const buildServiceHistoryUpsert = (historyData = {}) => {
  const recordedResourceFields = Object.fromEntries(
    ["hoursSpent", "laborCost", "partsCost", "additionalCost", "totalServiceCost"]
      .filter((field) => historyData[field] !== null && historyData[field] !== undefined)
      .map((field) => [field, historyData[field]]),
  );
  const historyInsertData = { ...historyData };
  // MongoDB rejects an upsert when the same path appears in both $setOnInsert
  // and $set. customerInputs is refreshed on every retry, so keep it only in
  // $set alongside the editable resource fields.
  [...Object.keys(recordedResourceFields), "customerInputs"].forEach((field) => delete historyInsertData[field]);
  return {
    $setOnInsert: historyInsertData,
    $set: { ...recordedResourceFields, customerInputs: historyData.customerInputs },
  };
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
  partInventory = null,
  providerCall = callStructuredAmpAnalysis,
  recalculate = calculateMaintenanceRecommendation,
  deferProvider = false,
}) => {
  if (serviceHistory.aiInterpretation?.status === "completed" && Number(serviceHistory.aiInterpretation?.analysisVersion || 0) >= 6) {
    return { interpretation: serviceHistory.aiInterpretation, recommendation };
  }
  const priorHistory = await ServiceHistory.find({ unit: unit._id, _id: { $ne: serviceHistory._id } })
    .sort({ serviceDate: -1 }).lean();
  const evidence = buildVisitEvidence({ unit, serviceHistory, priorHistory, recommendation });
  let providerResult;
  if (deferProvider) {
    // The completed task, service history, payment, proof, and customer
    // request are authoritative operational records. Save them first and let
    // the bounded retry worker enrich the follow-up with AI afterward instead
    // of holding the technician's completion button for an external provider.
    providerResult = { provider: "system-fallback", insight: null, error: "Advanced follow-up analysis is queued. The recorded service schedule is available now." };
  } else {
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
  }
  const savedPartInventory = !partInventory && serviceHistory.aiInterpretation?.inventoryMessage
    ? {
      message: serviceHistory.aiInterpretation.inventoryMessage,
      matches: Array.isArray(serviceHistory.aiInterpretation.inventoryMatches) ? serviceHistory.aiInterpretation.inventoryMatches : [],
    }
    : null;
  const interpretation = finalizeVisitAnalysis({
    providerResult, evidence, recommendation, serviceHistory,
    partInventory: partInventory || savedPartInventory,
  });
  const analysisAttempts = Number(serviceHistory.aiInterpretation?.analysisAttempts || 0) + 1;
  const lastAnalysisAttemptAt = new Date();
  interpretation.analysisAttempts = analysisAttempts;
  interpretation.lastAnalysisAttemptAt = lastAnalysisAttemptAt;
  interpretation.nextAnalysisAttemptAt = interpretation.provider !== "openai" && analysisAttempts < AI_ANALYSIS_MAX_ATTEMPTS
    ? new Date(lastAnalysisAttemptAt.getTime() + AI_RETRY_DELAYS_MS[Math.min(analysisAttempts - 1, AI_RETRY_DELAYS_MS.length - 1)])
    : null;
  serviceHistory.aiInterpretation = interpretation;
  await serviceHistory.save();

  // Keep an evidence-based condition follow-up visible immediately. The
  // delayed OpenAI review can enrich the same record later, but it must not
  // hide a documented component concern from managers or customers.
  await Unit.updateOne({ _id: unit._id }, { $set: {
      "amp.visitFollowUp": {
        analysisVersion: interpretation.analysisVersion,
        sourceServiceHistoryId: String(serviceHistory._id),
        provider: interpretation.provider,
        currentStatus: interpretation.currentStatus,
        technicianRecorded: interpretation.technicianRecorded,
        previousVisitHistory: interpretation.previousVisitHistory,
        currentIssues: interpretation.currentIssues,
        completedWork: interpretation.completedWork,
        severity: interpretation.severity,
        riskType: interpretation.riskType,
        predictedRisk: interpretation.predictedRisk,
        affectedComponent: interpretation.affectedComponent,
        overallCondition: interpretation.overallCondition,
        componentConcern: interpretation.componentConcern,
        evidenceConfidence: interpretation.evidenceConfidence,
        recommendationMode: interpretation.recommendationMode,
        repairOrReplacement: interpretation.repairOrReplacement,
        recommendedPart: interpretation.recommendedPart,
        partRecommendationStatus: interpretation.partRecommendationStatus,
        inventoryMessage: interpretation.inventoryMessage,
        inventoryMatches: interpretation.inventoryMatches,
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
  if (interpretation.recommendationMode === "condition_based" && interpretation.recommendedFollowUpDate) {
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
  const technicianStatus = normalizeTechnicianStatus(
    payload.technicianStatus ?? payload.technician_status ?? latestLog.technicianStatus,
  );
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
    technicianStatus,
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
  const serviceHistory = sourceTaskId
    ? await ServiceHistory.findOneAndUpdate(
      { unit: unit._id, sourceTaskId: String(sourceTaskId) },
      buildServiceHistoryUpsert(historyData),
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

  const partInventory = await recordedPartsInventory({ unit, partsUsed });
  const analysis = await analyzeCompletedVisit({ unit, serviceHistory, recommendation, technicianId, partInventory, deferProvider: true });
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
  buildServiceHistoryUpsert,
  completeServiceForUnit,
  recordedPartsInventory,
  validateStrictServicePayload,
};
