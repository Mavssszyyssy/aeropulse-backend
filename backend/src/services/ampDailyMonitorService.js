const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const ServiceRequest = require("../models/ServiceRequest");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { AI_ANALYSIS_MAX_ATTEMPTS, analyzeCompletedVisit } = require("../domain/serviceCompletionService");
const { createDedupedNotification, notifyOperationalStaff } = require("./operationalNotificationService");
const { formatDateKeyInTimeZone, businessDay } = require("../utils/dateTime");
const env = require("../config/env");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const displayService = (value) => value === "deep_cleaning" ? "Deep cleaning" : "Regular cleaning";

const maintenanceAlertForRecommendation = (recommendation, now = new Date()) => {
  const due = new Date(recommendation?.bestServicedBy || "");
  if (Number.isNaN(due.getTime())) return null;
  const daysUntilDue = Math.round((businessDay(due).getTime() - businessDay(now).getTime()) / MS_PER_DAY);
  if (daysUntilDue > 30) return null;
  const dateKey = formatDateKeyInTimeZone(due);
  if (daysUntilDue < 0) return {
    tier: "amp_overdue", severity: "critical", title: "AC maintenance is overdue",
    message: `${displayService(recommendation.recommendedService)} was recommended by ${due.toLocaleDateString("en-US")}. Open My AC Units to review it.`, dateKey, daysUntilDue,
  };
  if (daysUntilDue <= 7) return {
    tier: "amp_due_soon", severity: "warning", title: "AC maintenance is due soon",
    message: `${displayService(recommendation.recommendedService)} is recommended by ${due.toLocaleDateString("en-US")}. Open My AC Units to plan your visit.`, dateKey, daysUntilDue,
  };
  return {
    tier: "maintenance_due", severity: "info", title: "Plan your next AC maintenance",
    message: `${displayService(recommendation.recommendedService)} is recommended by ${due.toLocaleDateString("en-US")}. Open My AC Units for the details.`, dateKey, daysUntilDue,
  };
};

const notifyMaintenanceForUnit = async (unit, recommendation, now = new Date()) => {
  if (!unit?.customer || ["retired", "on_hold"].includes(unit.status)) return null;
  const alert = maintenanceAlertForRecommendation(recommendation, now);
  if (!alert) return null;
  return createDedupedNotification({
    user: unit.customer,
    type: "service",
    category: alert.tier,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    targetId: String(unit._id || unit.id || recommendation.unitId || ""),
    targetType: "unit",
    dedupeKey: `amp:${unit._id || unit.id}:${alert.tier}:${alert.dateKey}`,
  }, { dedupeMinutes: 0 });
};

const retryUnavailableVisitAnalyses = async ({ now = new Date(), batchSize = 50 } = {}) => {
  const stats = { queued: 0, completed: 0, unavailable: 0, errors: 0 };
  if (!env.openAiApiKey) return stats;
  let lastId = null;
  const size = Math.min(Math.max(Number(batchSize) || 50, 1), 100);
  while (true) {
    const query = {
      "aiInterpretation.status": "unavailable",
      $and: [
        { $or: [{ "aiInterpretation.analysisAttempts": { $exists: false } }, { "aiInterpretation.analysisAttempts": { $lt: AI_ANALYSIS_MAX_ATTEMPTS } }] },
        { $or: [{ "aiInterpretation.nextAnalysisAttemptAt": { $exists: false } }, { "aiInterpretation.nextAnalysisAttemptAt": null }, { "aiInterpretation.nextAnalysisAttemptAt": { $lte: now } }] },
      ],
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    };
    const histories = await ServiceHistory.find(query).sort({ _id: 1 }).limit(size);
    if (!histories.length) break;
    for (const serviceHistory of histories) {
      stats.queued += 1;
      try {
        const unit = await Unit.findById(serviceHistory.unit);
        if (!unit || !unit.customer || unit.status === "retired") continue;
        const recommendation = await calculateMaintenanceRecommendation(unit._id);
        const result = await analyzeCompletedVisit({
          unit,
          serviceHistory,
          recommendation,
          technicianId: serviceHistory.technician,
        });
        if (result.interpretation?.provider === "openai") {
          stats.completed += 1;
          await createDedupedNotification({
            user: unit.customer,
            type: "service",
            category: "service_follow_up_updated",
            severity: result.interpretation.severity === "urgent" ? "critical" : result.interpretation.severity === "soon" ? "warning" : "info",
            title: "Your AC follow-up recommendation is ready",
            message: result.interpretation.customerSummary,
            targetId: String(unit._id),
            targetType: "unit",
            route: `/customer/units/${unit._id}`,
            dedupeKey: `amp-visit-analysis:${serviceHistory._id}:completed`,
          }, { dedupeMinutes: 0 });
        } else {
          stats.unavailable += 1;
        }
      } catch (error) {
        stats.errors += 1;
        console.warn("AMP visit analysis retry failed", { serviceHistoryId: String(serviceHistory._id), reason: error.message });
      }
    }
    lastId = histories.at(-1)._id;
    if (histories.length < size) break;
  }
  return stats;
};

const runAmpDailyMonitor = async ({ now = new Date(), limit = 250 } = {}) => {
  const batchSize = Math.min(Math.max(Number(limit) || 250, 1), 500);
  const stats = { scanned: 0, alertsCreated: 0, dueSoon: 0, overdue: 0, errors: 0 };
  const branchSummary = new Map();
  const cohortCache = new Map();
  let lastId = null;
  while (true) {
    const units = await Unit.find({
      status: { $in: ["active", "service_due"] },
      customer: { $ne: null },
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    })
      .select("customer brand modelName serviceBranch status")
      .sort({ _id: 1 })
      .limit(batchSize);
    if (!units.length) break;
    stats.scanned += units.length;
    const unitIds = units.map(unit => String(unit._id));
    const requests = await ServiceRequest.find({ unitId: { $in: unitIds }, status: { $ne: "Cancelled" } })
      .select("unitId issue issueType payload status createdAt").sort({ createdAt: -1 }).lean();
    const requestsByUnit = new Map();
    requests.forEach(request => requestsByUnit.set(String(request.unitId), [...(requestsByUnit.get(String(request.unitId)) || []), request]));
    for (const unit of units) {
      try {
        const recommendation = await calculateMaintenanceRecommendation(unit._id, { asOfDate: now, cohortCache, serviceRequests: requestsByUnit.get(String(unit._id)) || [] });
        const alert = maintenanceAlertForRecommendation(recommendation, now);
        if (!alert) continue;
        const notification = await notifyMaintenanceForUnit(unit, recommendation, now);
        if (notification && notification.$locals?.wasDeduplicated !== true) stats.alertsCreated += 1;
        if (alert.daysUntilDue < 0) stats.overdue += 1; else stats.dueSoon += 1;
        const branch = String(unit.serviceBranch || "Unassigned");
        const summary = branchSummary.get(branch) || { dueSoon: 0, overdue: 0 };
        if (alert.daysUntilDue < 0) summary.overdue += 1; else summary.dueSoon += 1;
        branchSummary.set(branch, summary);
      } catch (error) {
        stats.errors += 1;
        console.warn("AMP daily monitor skipped a unit", { unitId: String(unit._id), reason: error.message });
      }
    }
    lastId = units.at(-1)._id;
    if (units.length < batchSize) break;
  }

  const dateKey = formatDateKeyInTimeZone(now);
  for (const [branch, summary] of branchSummary) {
    await notifyOperationalStaff({
      branch: branch === "Unassigned" ? "" : branch,
      type: "service",
      category: "maintenance_pipeline",
      severity: summary.overdue ? "warning" : "info",
      title: "AMP maintenance pipeline updated",
      message: `${summary.overdue} overdue and ${summary.dueSoon} upcoming AC maintenance visit(s) are ready for review${branch === "Unassigned" ? "" : ` in ${branch}`}.`,
      targetType: "amp_pipeline",
      route: "/manager/amp",
      dedupeKey: `amp-pipeline:${branch}:${dateKey}`,
      dedupeMinutes: 0,
    });
  }

  stats.visitAnalysisRetries = await retryUnavailableVisitAnalyses({ now });
  return stats;
};

module.exports = { maintenanceAlertForRecommendation, notifyMaintenanceForUnit, retryUnavailableVisitAnalyses, runAmpDailyMonitor };
