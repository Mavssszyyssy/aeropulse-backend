function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildMaintenanceRecommendation({ unit } = {}) {
  const bestServicedBy = unit?.bestServicedBy || unit?.amp?.bestServicedBy || unit?.amp?.nextIdealServiceDate || "";
  const recommendedService = unit?.recommendedService ?? unit?.amp?.recommendedService ?? "";
  return {
    bestServicedBy, recommendedService,
    recommendationBasis: unit?.recommendationBasis || unit?.amp?.recommendationBasis || "Maintenance timing is being calculated from recorded service history.",
    capacityAssessment: unit?.capacityAssessment || unit?.amp?.capacityAssessment || null,
    lastServiceDate: unit?.lastServiceDate || unit?.amp?.lastServiceDate || null,
    lastCleaningDate: unit?.lastCleaningDate || unit?.amp?.lastCleaningDate || null,
    dataQuality: unit?.dataQuality || unit?.amp?.dataQuality || null,
    patternAnalysis: unit?.patternAnalysis || unit?.amp?.patternAnalysis || null,
    maintenanceSignals: unit?.maintenanceSignals || unit?.amp?.maintenanceSignals || null,
    overdue: bestServicedBy ? businessDayNumber(bestServicedBy) < businessDayNumber(new Date()) : false,
  };
}

export function buildNextRecommendedMaintenance(recommendation) {
  const due = parseDate(recommendation?.bestServicedBy);
  const daysUntil = due ? businessDayNumber(due) - businessDayNumber(new Date()) : null;
  const serviceLabel = ({
    deep_cleaning: "Deep cleaning",
    regular_cleaning: "Regular cleaning",
    inspection: "AC inspection",
    repair: "Repair assessment",
  })[recommendation?.recommendedService] || "Service details needed";
  return {
    date: due ? due.toISOString().slice(0, 10) : "",
    label: due ? (daysUntil < 0 ? `${Math.abs(daysUntil)} day(s) overdue` : daysUntil === 0 ? "Suggested for today" : `Suggested in ${daysUntil} day(s)`) : "Installation or cleaning date needed",
    urgency: daysUntil === null ? "Pending" : daysUntil < 0 ? "Overdue" : daysUntil <= 30 ? "Due Soon" : "Suggested",
    color: daysUntil === null ? "#6B7280" : daysUntil < 0 ? "#DC2626" : daysUntil <= 30 ? "#D97706" : "#059669",
    message: `${serviceLabel}. ${recommendation?.recommendationBasis || ""}`.trim(),
    recommendedService: recommendation?.recommendedService || "",
    capacityAssessment: recommendation?.capacityAssessment || null,
    dataQuality: recommendation?.dataQuality || null,
  };
}

function businessDayNumber(value) {
  const date = parseDate(value);
  return date ? Math.floor((date.getTime() + 8 * 3600000) / 86400000) : NaN;
}

export function buildUnitRecommendationMap(units = []) {
  return units.reduce((map, unit) => { map[String(unit.id)] = buildMaintenanceRecommendation({ unit }); return map; }, {});
}
