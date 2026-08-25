const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");

const MS_PER_DAY = 86400000;
const DEFAULT_AVERAGE_SERVICE_REVENUE = 2500;
const addDays = (date, days) => new Date(date.getTime() + Number(days || 0) * MS_PER_DAY);
const startOfMonth = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const addMonths = (date, months) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
const monthKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
const monthLabel = (date) => date.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const daysBetween = (from, to) => Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);

const buildRecordedMaintenanceTrends = async ({ branch = "" } = {}) => {
  const units = await Unit.find({
    status: { $ne: "retired" },
    ...(branch ? { serviceBranch: branch } : {}),
  }).select("brand modelName serviceBranch amp.recommendedService").limit(1000).lean();
  const unitIds = units.map((unit) => unit._id);
  const histories = unitIds.length
    ? await ServiceHistory.find({ unit: { $in: unitIds } }).select("unit partsUsed serviceDate").sort({ serviceDate: -1 }).limit(5000).lean()
    : [];
  const unitMap = new Map(units.map((unit) => [String(unit._id), unit]));
  const modelMap = new Map(); const brandMap = new Map(); const componentMap = new Map(); const serviceMap = new Map();
  units.forEach((unit) => {
    const serviceType = unit.amp?.recommendedService || "regular_cleaning";
    serviceMap.set(serviceType, (serviceMap.get(serviceType) || 0) + 1);
  });
  histories.forEach((history) => {
    const unit = unitMap.get(String(history.unit));
    if (!unit) return;
    const model = [unit.brand, unit.modelName].filter(Boolean).join(" ") || "Unspecified model";
    const brand = unit.brand || "Unspecified brand";
    const modelRow = modelMap.get(model) || { label: model, serviceCount: 0, units: new Set() };
    modelRow.serviceCount += 1; modelRow.units.add(String(history.unit)); modelMap.set(model, modelRow);
    const brandRow = brandMap.get(brand) || { label: brand, serviceCount: 0, units: new Set() };
    brandRow.serviceCount += 1; brandRow.units.add(String(history.unit)); brandMap.set(brand, brandRow);
    (history.partsUsed || []).forEach((part) => { const label = String(part || "").trim(); if (label) componentMap.set(label, (componentMap.get(label) || 0) + 1); });
  });
  const finish = (map) => Array.from(map.values()).map((item) => ({
    label: item.label, recordedServices: item.serviceCount, servicedUnits: item.units.size,
    servicesPerUnit: Number((item.serviceCount / Math.max(1, item.units.size)).toFixed(2)),
  })).sort((a, b) => b.servicesPerUnit - a.servicesPerUnit || b.recordedServices - a.recordedServices).slice(0, 10);
  return {
    modelTrends: finish(modelMap), brandTrends: finish(brandMap),
    componentReplacements: Array.from(componentMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([component, count]) => ({ component, count })),
    serviceDemand: Array.from(serviceMap.entries()).map(([serviceType, count]) => ({ serviceType, count })).sort((a, b) => b.count - a.count),
  };
};

const getManagerServicePipeline = async ({ days = 30, branch = "" } = {}) => {
  const now = new Date();
  const windowEnd = addDays(now, Number(days || 30));
  const [units, aggregate] = await Promise.all([Unit.aggregate([
    { $match: {
      status: { $in: ["active", "service_due"] },
      "amp.bestServicedBy": { $lte: windowEnd },
      ...(branch ? { serviceBranch: branch } : {}),
    } },
    { $lookup: { from: "servicehistories", let: { unitId: "$_id" }, pipeline: [
      { $match: { $expr: { $eq: ["$unit", "$$unitId"] } } }, { $sort: { serviceDate: -1 } }, { $limit: 1 },
      { $project: { serviceDate: 1, serviceType: 1, visitType: 1, findings: 1, actionTaken: 1, partsUsed: 1 } },
    ], as: "lastVisit" } },
    { $addFields: { lastVisit: { $first: "$lastVisit" } } },
    { $sort: { "amp.bestServicedBy": 1 } }, { $limit: 200 },
  ]), buildRecordedMaintenanceTrends({ branch })]);
  return {
    generatedAt: new Date().toISOString(), windowDays: Number(days || 30), aggregate,
    units: units.map((unit) => {
      const dueDate = new Date(unit.amp.bestServicedBy);
      return {
        unitId: String(unit._id), serialNumber: unit.serialNumber, customerName: unit.customerName || "Customer",
        modelName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "AC Unit", serviceBranch: unit.serviceBranch || "",
        zipCode: unit.installation?.zipCode || "", addressLine: unit.installation?.addressLine || "",
        bestServicedBy: dueDate.toISOString(), recommendedService: unit.amp.recommendedService || "regular_cleaning",
        recommendationBasis: unit.amp.recommendationBasis || "", daysUntilDue: daysBetween(now, dueDate),
        overdue: dueDate < now, lastServiceDate: unit.lastVisit?.serviceDate || null,
        warrantyStatus: unit.warranty?.status || "pending_activation",
        capacityAssessment: unit.amp.capacityAssessment || null,
      };
    }),
  };
};

const getOwnerServiceForecast = async ({ months = 12, averageRevenue } = {}) => {
  const now = new Date(); const firstMonth = startOfMonth(now); const afterLastMonth = addMonths(firstMonth, Number(months || 12));
  const serviceRevenue = Number(averageRevenue || DEFAULT_AVERAGE_SERVICE_REVENUE);
  const [buckets, serviceTypes, componentRows, branchRows, recordedTrends] = await Promise.all([
    Unit.aggregate([
      { $match: { status: { $in: ["active", "service_due"] }, "amp.bestServicedBy": { $gte: firstMonth, $lt: afterLastMonth } } },
      { $group: { _id: { year: { $year: "$amp.bestServicedBy" }, month: { $month: "$amp.bestServicedBy" } }, serviceVolume: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
    Unit.aggregate([
      { $match: { status: { $in: ["active", "service_due"] } } },
      { $group: { _id: { $ifNull: ["$amp.recommendedService", "regular_cleaning"] }, count: { $sum: 1 } } },
    ]),
    ServiceHistory.find({ partsUsed: { $exists: true, $ne: [] } }).select("partsUsed serviceDate").sort({ serviceDate: -1 }).limit(2000).lean(),
    Unit.aggregate([
      { $match: { status: { $in: ["active", "service_due"] }, "amp.bestServicedBy": { $gte: firstMonth, $lt: afterLastMonth } } },
      { $group: { _id: { $ifNull: ["$serviceBranch", "Unassigned"] }, upcomingServices: { $sum: 1 } } },
      { $sort: { upcomingServices: -1 } },
    ]),
    buildRecordedMaintenanceTrends(),
  ]);
  const bucketMap = new Map(buckets.map((item) => [`${item._id.year}-${String(item._id.month).padStart(2, "0")}`, item.serviceVolume]));
  const forecast = Array.from({ length: Number(months || 12) }, (_unused, index) => {
    const date = addMonths(firstMonth, index); const volume = bucketMap.get(monthKey(date)) || 0;
    return { month: monthKey(date), label: monthLabel(date), serviceVolume: volume, projectedRevenue: volume * serviceRevenue };
  });
  const parts = new Map();
  componentRows.forEach((row) => (row.partsUsed || []).forEach((part) => { const name = String(part || "").trim(); if (name) parts.set(name, (parts.get(name) || 0) + 1); }));
  return {
    generatedAt: new Date().toISOString(), months: Number(months || 12), averageServiceRevenue: serviceRevenue,
    totalForecastedServices: forecast.reduce((sum, item) => sum + item.serviceVolume, 0),
    totalProjectedRevenue: forecast.reduce((sum, item) => sum + item.projectedRevenue, 0), forecast,
    recommendedServiceDemand: serviceTypes.map((item) => ({ serviceType: item._id, count: item.count })),
    recordedPartsTrend: Array.from(parts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([component, count]) => ({ component, count })),
    branchMaintenanceVolume: branchRows.map((item) => ({ branch: item._id, upcomingServices: item.upcomingServices })),
    modelTrends: recordedTrends.modelTrends,
    brandTrends: recordedTrends.brandTrends,
  };
};

module.exports = { getManagerServicePipeline, getOwnerServiceForecast };
