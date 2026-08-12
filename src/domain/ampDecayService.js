const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const EnvironmentalLog = require("../models/EnvironmentalLog");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 60;
const DEFAULT_DAILY_DECAY = 0.22;

const startOfUtcDay = (value) => {
  const date = value ? new Date(value) : new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const addDays = (date, days) => new Date(date.getTime() + days * MS_PER_DAY);

const toPeriodLabel = (date) =>
  date.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const mean = (values, fallback) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return fallback;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const summarizeEnvironmentalStress = (logs) => {
  const hotDayCount = logs.filter((log) => Number(log?.weather?.maxTempC) > 32).length;
  const humidDayCount = logs.filter((log) => Number(log?.weather?.avgHumidityPercent) >= 80).length;
  const rainyDayCount = logs.filter((log) => Number(log?.weather?.rainfallMm || 0) >= 20).length;
  const poorAirDayCount = logs.filter((log) => Number(log?.weather?.airQualityIndex) >= 100).length;

  const reasons = [];
  if (hotDayCount > 0) reasons.push("extreme_heat");
  if (humidDayCount > 0) reasons.push("high_humidity");
  if (rainyDayCount > 0) reasons.push("heavy_rainfall");
  if (poorAirDayCount > 0) reasons.push("poor_air_quality");

  return {
    hotDayCount,
    humidDayCount,
    rainyDayCount,
    poorAirDayCount,
    reasons,
  };
};

const getTechnicianInputFactor = (serviceHistory) => {
  const inputs = serviceHistory?.technicianInputs || {};

  // The technician visit is our only direct view into usage and physical condition.
  // These factors tune the historical curve without pretending we have live sensors.
  const usageHours = Number(inputs.usageHoursPerDay || 8);
  const usageFactor = usageHours >= 18 ? 1.4 : usageHours >= 12 ? 1.2 : usageHours <= 4 ? 0.85 : 1;

  const filterFactor = {
    clean: 0.9,
    normal: 1,
    dusty: 1.2,
    clogged: 1.45,
  }[inputs.filterCondition] || 1;

  const coilFactor = {
    clean: 0.9,
    normal: 1,
    dusty: 1.18,
    iced: 1.35,
  }[inputs.coilCondition] || 1;

  const drainageFactor = {
    clear: 1,
    slow: 1.12,
    blocked: 1.35,
  }[inputs.drainageCondition] || 1;

  const voltageFactor = {
    stable: 1,
    fluctuating: 1.15,
    unstable: 1.35,
  }[inputs.voltageStability] || 1;

  return usageFactor * filterFactor * coilFactor * drainageFactor * voltageFactor;
};

const getEnvironmentalMultiplier = (log) => {
  if (Number.isFinite(log?.stress?.degradationMultiplier)) {
    return log.stress.degradationMultiplier;
  }

  const maxTempC = Number(log?.weather?.maxTempC);
  const humidity = Number(log?.weather?.avgHumidityPercent);
  const rainfallMm = Number(log?.weather?.rainfallMm || 0);
  const airQualityIndex = Number(log?.weather?.airQualityIndex);

  let multiplier = 1;

  // Requirement: days over 32 C decay the unit 2x faster.
  // This is the largest single weather stressor because compressor load rises sharply.
  if (Number.isFinite(maxTempC) && maxTempC > 32) {
    multiplier *= 2;
  } else if (Number.isFinite(maxTempC) && maxTempC > 29) {
    multiplier *= 1.25;
  }

  // High humidity increases coil moisture, biofilm, and drainage stress.
  if (Number.isFinite(humidity) && humidity >= 80) {
    multiplier *= 1.18;
  }

  // Rainy periods are not always harmful, but repeated moisture raises corrosion risk.
  if (Number.isFinite(rainfallMm) && rainfallMm >= 20) {
    multiplier *= 1.08;
  }

  // Dirty air accelerates filter loading and coil fouling.
  if (Number.isFinite(airQualityIndex) && airQualityIndex >= 100) {
    multiplier *= 1.15;
  }

  return multiplier;
};

const calculate_next_service_date = async (unitId, options = {}) => {
  const asOfDate = startOfUtcDay(options.asOfDate || new Date());
  const lookbackDays = Number(options.lookbackDays || 30);
  const shouldPersist = options.persist !== false;

  // Load the unit first because the zip code controls which localized weather logs apply.
  const unit = await Unit.findById(unitId);
  if (!unit) {
    const error = new Error("Unit not found");
    error.status = 404;
    throw error;
  }

  // The latest service history entry is the baseline. AMP never invents a fresh condition
  // score between visits; it decays this discrete technician-observed baseline.
  const lastService = await ServiceHistory.findOne({ unit: unit._id })
    .sort({ serviceDate: -1 })
    .lean();

  if (!lastService) {
    const error = new Error("No service history baseline found for this unit");
    error.status = 409;
    throw error;
  }

  const zipCode = String(unit.installation?.zipCode || "").trim();
  if (!zipCode) {
    const error = new Error("Unit installation zip code is required for AMP weather decay");
    error.status = 409;
    throw error;
  }

  const lookbackStart = addDays(asOfDate, -lookbackDays);
  const environmentalLogs = await EnvironmentalLog.find({
    zipCode,
    date: { $gte: lookbackStart, $lte: asOfDate },
  })
    .sort({ date: 1 })
    .lean();

  // If weather ingestion is delayed, the service still returns a conservative answer.
  // The fallback multiplier is 1.0, meaning normal historical decay only.
  const weatherMultipliers = environmentalLogs.map(getEnvironmentalMultiplier);
  const averageWeatherMultiplier = mean(weatherMultipliers, 1);
  const environmentalStress = summarizeEnvironmentalStress(environmentalLogs);

  const baselineHealth = Number(lastService.baselineHealthScore);
  const serviceThreshold = Number(unit.amp?.serviceThreshold || DEFAULT_THRESHOLD);
  const baseDailyDecay = Number(unit.amp?.dailyBaseDecay || DEFAULT_DAILY_DECAY);
  const historicalCurveFactor = Number(unit.amp?.historicalCurveFactor || 1);
  const technicianInputFactor = getTechnicianInputFactor(lastService);

  const lastServiceDate = startOfUtcDay(lastService.serviceDate);
  const elapsedDays = Math.max(0, Math.floor((asOfDate.getTime() - lastServiceDate.getTime()) / MS_PER_DAY));

  // Reconstruct current health by applying the recent environmental curve to elapsed days.
  // This is not shown to customers; it is only used to find the crossing date.
  const dailyDecay =
    baseDailyDecay *
    historicalCurveFactor *
    technicianInputFactor *
    averageWeatherMultiplier;
  const estimatedCurrentHealth = Math.max(0, baselineHealth - elapsedDays * dailyDecay);

  // If the estimated score already crossed the threshold, recommend service immediately.
  const daysUntilThreshold =
    estimatedCurrentHealth <= serviceThreshold
      ? 0
      : Math.ceil((estimatedCurrentHealth - serviceThreshold) / dailyDecay);

  const nextIdealServiceDate = addDays(asOfDate, daysUntilThreshold);
  const nextIdealServicePeriod = toPeriodLabel(nextIdealServiceDate);

  if (shouldPersist) {
    // Persist the customer-facing period and internal date so dashboards can query quickly.
    unit.amp.currentHealthScore = Math.round(estimatedCurrentHealth * 10) / 10;
    unit.amp.nextIdealServiceDate = nextIdealServiceDate;
    unit.amp.nextIdealServicePeriod = nextIdealServicePeriod;
    unit.amp.lastCalculatedAt = new Date();
    unit.status = estimatedCurrentHealth <= serviceThreshold ? "service_due" : "active";
    await unit.save();
  }

  return {
    unitId: unit.id,
    serialNumber: unit.serialNumber,
    zipCode,
    baseline: {
      serviceHistoryId: String(lastService._id),
      serviceDate: lastService.serviceDate,
      baselineHealthScore: baselineHealth,
    },
    decay: {
      lookbackDays,
      environmentalLogCount: environmentalLogs.length,
      environmentalStress,
      averageWeatherMultiplier,
      technicianInputFactor,
      historicalCurveFactor,
      dailyDecay,
      estimatedCurrentHealth,
      serviceThreshold,
    },
    next_ideal_service_date: nextIdealServiceDate.toISOString(),
    next_ideal_service_period: nextIdealServicePeriod,
  };
};

module.exports = {
  calculate_next_service_date,
  calculateNextServiceDate: calculate_next_service_date,
  getEnvironmentalMultiplier,
};
