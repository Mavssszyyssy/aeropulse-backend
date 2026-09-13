const clean = (value, max = 1200) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);

const dateLabel = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "the suggested date";
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
};

const severityText = {
  routine: "routine care is appropriate",
  monitor: "the recorded concern should be watched",
  soon: "the recorded concern should be checked soon",
  urgent: "the recorded concern needs prompt attention",
  critical: "the recorded concern needs immediate attention",
  not_assessed: "the visit could not be assessed automatically",
};

const sourceText = {
  same_unit: "this AC's completed cleaning history",
  same_model: "completed cleaning records for the same AC model",
  same_brand_type: "completed cleaning records for similar ACs of the same brand and type",
  same_brand: "completed cleaning records for ACs of the same brand",
  system_default: "the 6-month starting schedule",
};

function routineAssessment(recommendation = {}) {
  const pattern = recommendation.patternAnalysis || {};
  const count = Number(pattern.intervalCount ?? recommendation.historicalBasis?.sampleSize ?? 0);
  const source = sourceText[pattern.source || recommendation.historicalBasis?.level] || "the available service records";
  if (recommendation.predictionSource === "openai") {
    return clean(`AEROPULSE reviewed ${source}${count ? `, including ${count} completed gap${count === 1 ? "" : "s"} between cleanings` : ""}. The suggested plan follows the cleaning pattern found in those records. Repairs and refrigerant concerns are reviewed for context but are not counted as cleaning visits.`);
  }
  if ((pattern.source || recommendation.historicalBasis?.level) === "system_default") {
    return "This AC does not have enough completed cleaning history for a personalized AI date yet. The current plan uses the 6-month starting schedule.";
  }
  return clean(`This plan uses ${source}${count ? `, including ${count} completed cleaning gap${count === 1 ? "" : "s"}` : ""}.`);
}

function routineDateReason(recommendation = {}) {
  const pattern = recommendation.patternAnalysis || {};
  const intervalDays = Number(recommendation.historicalBasis?.intervalDays || recommendation.routineMaintenance?.intervalDays || 0);
  const months = intervalDays ? Math.max(1, Math.round(intervalDays / 30)) : null;
  const anchor = recommendation.lastCleaningDate ? "the latest completed cleaning" : "the recorded installation";
  const source = sourceText[pattern.source || recommendation.historicalBasis?.level] || "the available service records";
  if (!recommendation.bestServicedBy) return "A completed cleaning or installation date is needed before AEROPULSE can suggest a date.";
  return clean(`${dateLabel(recommendation.bestServicedBy)} was selected about ${months ? `${months} month${months === 1 ? "" : "s"}` : "the recommended interval"} after ${anchor}. The timing comes from ${source}.`);
}

function explanationForRecommendation(recommendation = {}) {
  const visit = recommendation.latestVisitAnalysis || recommendation.conditionBasedFollowUp || null;
  if (visit) {
    const assessment = clean(visit.aiAssessment || [
      visit.problemsFound ? `The technician recorded: ${visit.problemsFound}` : visit.predictedRisk,
      severityText[visit.severity],
      Array.isArray(visit.recommendedActions) ? visit.recommendedActions[0] : "",
    ].filter(Boolean).join(" "));
    const whyThisDate = clean(visit.whyThisDate || `${dateLabel(recommendation.bestServicedBy || visit.recommendedDate)} was selected because ${severityText[visit.severity] || "the technician's report requires follow-up"}. The timing uses the completed technician report and the service history available for this AC.`);
    return { aiAssessment: assessment, whyThisDate };
  }
  return {
    aiAssessment: routineAssessment(recommendation),
    whyThisDate: routineDateReason(recommendation),
  };
}

module.exports = { explanationForRecommendation, routineAssessment, routineDateReason };
