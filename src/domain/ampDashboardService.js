const Unit = require("../models/Unit");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_AVERAGE_SERVICE_REVENUE = 2500;

const addDays = (date, days) => new Date(date.getTime() + days * MS_PER_DAY);

const startOfMonth = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const addMonths = (date, months) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));

const monthKey = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const monthLabel = (date) =>
  date.toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const daysBetween = (from, to) =>
  Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);

const confidenceFromDaysSinceVisit = (daysSinceLastVisit) => {
  if (!Number.isFinite(daysSinceLastVisit)) return "Low";
  if (daysSinceLastVisit <= 45) return "High";
  if (daysSinceLastVisit <= 120) return "Med";
  return "Low";
};

const buildChainReactionWarnings = (unit, zipClusterCounts) => {
  const warnings = [];
  const dueDate = unit.amp?.nextIdealServiceDate
    ? new Date(unit.amp.nextIdealServiceDate)
    : null;
  const daysUntilDue = dueDate ? daysBetween(new Date(), dueDate) : null;
  const zipCode = unit.installation?.zipCode || "";
  const clusterCount = zipClusterCounts.get(zipCode) || 0;

  if (Number.isFinite(daysUntilDue) && daysUntilDue <= 7) {
    warnings.push({
      level: "high",
      code: "IMMINENT_SERVICE_CLUSTER",
      message: "Service period is inside 7 days. Route to dispatch for immediate scheduling.",
      dispatchRoute: "priority_dispatch",
    });
  }

  if (clusterCount >= 3) {
    warnings.push({
      level: "medium",
      code: "ZIP_CLUSTER",
      message: `${clusterCount} units in ${zipCode} are entering service windows. Batch dispatch by area.`,
      dispatchRoute: "area_batch_dispatch",
    });
  }

  if (Number(unit.amp?.historicalCurveFactor || 1) >= 1.2) {
    warnings.push({
      level: "medium",
      code: "ACCELERATED_DECAY_CURVE",
      message: "Historical curve is elevated. Assign a senior technician or bring likely replacement parts.",
      dispatchRoute: "senior_tech_review",
    });
  }

  return warnings;
};

const getManagerServicePipeline = async ({ days = 30 } = {}) => {
  const now = new Date();
  const windowEnd = addDays(now, Number(days || 30));

  // Aggregate query: find units due soon and join only the latest physical visit.
  const units = await Unit.aggregate([
    {
      $match: {
        status: { $in: ["active", "service_due"] },
        "amp.nextIdealServiceDate": { $gte: now, $lte: windowEnd },
      },
    },
    {
      $lookup: {
        from: "servicehistories",
        let: { unitId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$unit", "$$unitId"] } } },
          { $sort: { serviceDate: -1 } },
          { $limit: 1 },
          {
            $project: {
              serviceDate: 1,
              visitType: 1,
              conditionRating: 1,
              technicianInputs: 1,
            },
          },
        ],
        as: "lastVisit",
      },
    },
    { $addFields: { lastVisit: { $first: "$lastVisit" } } },
    { $sort: { "amp.nextIdealServiceDate": 1 } },
    { $limit: 200 },
  ]);

  const zipClusterCounts = units.reduce((counts, unit) => {
    const zipCode = unit.installation?.zipCode || "";
    if (!zipCode) return counts;
    counts.set(zipCode, (counts.get(zipCode) || 0) + 1);
    return counts;
  }, new Map());

  return {
    generatedAt: new Date().toISOString(),
    windowDays: Number(days || 30),
    units: units.map((unit) => {
      const dueDate = new Date(unit.amp.nextIdealServiceDate);
      const lastVisitDate = unit.lastVisit?.serviceDate
        ? new Date(unit.lastVisit.serviceDate)
        : null;
      const daysSinceLastVisit = lastVisitDate
        ? daysBetween(lastVisitDate, now)
        : null;

      return {
        unitId: String(unit._id),
        serialNumber: unit.serialNumber,
        customerName: unit.customerName || "Customer",
        modelName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "AC Unit",
        zipCode: unit.installation?.zipCode || "",
        addressLine: unit.installation?.addressLine || "",
        nextIdealServiceDate: dueDate.toISOString(),
        nextIdealServicePeriod: unit.amp.nextIdealServicePeriod,
        daysUntilDue: daysBetween(now, dueDate),
        lastPhysicalVisitDate: lastVisitDate ? lastVisitDate.toISOString() : "",
        daysSinceLastVisit,
        confidence: confidenceFromDaysSinceVisit(daysSinceLastVisit),
        chainReactionWarnings: buildChainReactionWarnings(unit, zipClusterCounts),
      };
    }),
  };
};

const getOwnerServiceForecast = async ({ months = 12, averageRevenue } = {}) => {
  const now = new Date();
  const firstMonth = startOfMonth(now);
  const afterLastMonth = addMonths(firstMonth, Number(months || 12));
  const serviceRevenue = Number(averageRevenue || DEFAULT_AVERAGE_SERVICE_REVENUE);

  // Aggregate query: bucket all fleet service windows by month for the next 12 months.
  const buckets = await Unit.aggregate([
    {
      $match: {
        status: { $in: ["active", "service_due"] },
        "amp.nextIdealServiceDate": { $gte: firstMonth, $lt: afterLastMonth },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$amp.nextIdealServiceDate" },
          month: { $month: "$amp.nextIdealServiceDate" },
        },
        serviceVolume: { $sum: 1 },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  const bucketMap = new Map(
    buckets.map((bucket) => [
      `${bucket._id.year}-${String(bucket._id.month).padStart(2, "0")}`,
      bucket.serviceVolume,
    ]),
  );

  const forecast = Array.from({ length: Number(months || 12) }, (_unused, index) => {
    const date = addMonths(firstMonth, index);
    const volume = bucketMap.get(monthKey(date)) || 0;
    return {
      month: monthKey(date),
      label: monthLabel(date),
      serviceVolume: volume,
      projectedRevenue: volume * serviceRevenue,
    };
  });

  const totalForecastedServices = forecast.reduce((sum, item) => sum + item.serviceVolume, 0);
  const totalProjectedRevenue = forecast.reduce((sum, item) => sum + item.projectedRevenue, 0);

  return {
    generatedAt: new Date().toISOString(),
    months: Number(months || 12),
    averageServiceRevenue: serviceRevenue,
    totalForecastedServices,
    totalProjectedRevenue,
    forecast,
  };
};

module.exports = {
  getManagerServicePipeline,
  getOwnerServiceForecast,
};
