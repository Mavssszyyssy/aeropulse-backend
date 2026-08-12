const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const addMonths = (date, months) => {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
};

const formatServiceWindow = (date) => {
  const monthName = date.toLocaleString("en-US", { month: "long" });
  const year = date.getFullYear();
  const week = Math.ceil(date.getDate() / 7);
  return `${monthName} ${year}, Week ${week}`;
};

const scoreFrom = (value, scores, fallback = 0) => {
  const key = String(value || "").toLowerCase();
  return scores[key] ?? fallback;
};

const estimateNextServiceWindow = (params = {}, previousPlan = null) => {
  const serviceDate = params.lastServiceDate || params.installationDate || new Date().toISOString();
  const start = new Date(serviceDate);
  const conditionBase = {
    excellent: 7,
    good: 5,
    fair: 3,
    poor: 2,
  }[String(params.conditionRating || "good").toLowerCase()] || 4;

  const usageHours = Number(params.usageHoursPerDay || 8);
  const usagePenalty = usageHours >= 18 ? 2 : usageHours >= 12 ? 1 : usageHours <= 4 ? -1 : 0;
  const environmentPenalty =
    scoreFrom(params.environmentDustLevel, { low: -1, moderate: 0, high: 1, severe: 2 }) +
    scoreFrom(params.occupancyLoad, { light: -1, normal: 0, heavy: 1 });
  const inspectionPenalty =
    scoreFrom(params.filterCondition, { clean: -1, normal: 0, dusty: 1, clogged: 2 }) +
    scoreFrom(params.coilCondition, { clean: -1, normal: 0, dusty: 1, iced: 2 }) +
    scoreFrom(params.drainageCondition, { clear: 0, slow: 1, blocked: 2 }) +
    scoreFrom(params.voltageStability, { stable: 0, fluctuating: 1, unstable: 2 });

  let monthsUntil = conditionBase - usagePenalty - environmentPenalty - inspectionPenalty;

  if (previousPlan?.nextServiceDate && params.lastServiceDate) {
    const previousTarget = new Date(previousPlan.nextServiceDate);
    const actualService = new Date(params.lastServiceDate);
    const daysEarly = Math.round((previousTarget.getTime() - actualService.getTime()) / 86400000);
    if (daysEarly > 30 && String(params.conditionRating).toLowerCase() !== "excellent") {
      monthsUntil -= 1;
    } else if (daysEarly < -30 && ["excellent", "good"].includes(String(params.conditionRating).toLowerCase())) {
      monthsUntil += 1;
    }
  }

  monthsUntil = clamp(Math.round(monthsUntil), 1, 8);
  const nextDate = addMonths(start, monthsUntil);

  return {
    label: formatServiceWindow(nextDate),
    monthsUntil,
    nextServiceDate: nextDate.toISOString(),
    generatedAt: new Date().toISOString(),
  };
};

module.exports = { estimateNextServiceWindow };
