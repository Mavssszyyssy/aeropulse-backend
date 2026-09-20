const mongoose = require("mongoose");
const Unit = require("../models/Unit");
const Product = require("../models/Product");
const ServiceHistory = require("../models/ServiceHistory");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const Order = require("../models/Order");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { getManagerServicePipeline, getOwnerServiceForecast, UNASSIGNED_BRANCH } = require("../domain/ampDashboardService");
const { assessServiceEvidence, serviceLabel, serviceTypeFor } = require("../domain/serviceEvidence");
const { effectiveWarrantyStatus, getWarrantyRecommendation, getWarrantyCoverage } = require("../domain/warrantyService");
const { notifyMaintenanceForUnit } = require("../services/ampDailyMonitorService");
const { BRANCHES } = require("../domain/branchRouting");
const { formatDateKeyInTimeZone } = require("../utils/dateTime");
const { assertAmpBranch } = require("../domain/ampAccess");

const INTERNAL_AMP_ROLES = new Set(["technician", "manager", "owner", "admin", "superadmin"]);
const displayService = serviceLabel;

const customerUnitName = (brand = "", model = "") => {
  const cleanBrand = String(brand || "").trim();
  const cleanModel = String(model || "").trim();
  if (!cleanModel) return cleanBrand || "Installed AC Unit";
  if (!cleanBrand || cleanModel.toLowerCase() === cleanBrand.toLowerCase() || cleanModel.toLowerCase().startsWith(`${cleanBrand.toLowerCase()} `)) return cleanModel;
  return `${cleanBrand} ${cleanModel}`;
};

const resolveManagerPipelineScope = ({ role, requestedBranch = "", activeBranch = "" }) => {
  const canViewAllBranches = role === "superadmin" || role === "owner";
  if (!canViewAllBranches) {
    const branch = String(activeBranch || "").trim();
    if (!BRANCHES.includes(branch)) {
      const error = new Error("This account does not have a valid branch assignment.");
      error.status = 403;
      throw error;
    }
    return { branch, includeAllBranches: false };
  }

  const branch = String(requestedBranch || "").trim();
  if (branch && !BRANCHES.includes(branch) && branch !== UNASSIGNED_BRANCH) {
    const error = new Error("Select a valid operating branch.");
    error.status = 400;
    throw error;
  }
  return { branch, includeAllBranches: true };
};

const serviceHistoryItem = (service) => ({
  id: String(service._id || service.id || ""),
  date: service.serviceDate,
  serviceType: serviceTypeFor(service),
  technicianStatus: service.technicianStatus || "",
  findings: service.findings || service.technicianInputs?.notes || "",
  actionTaken: service.actionTaken || (service.serviceActions || []).join(", "),
  partsUsed: Array.isArray(service.partsUsed) ? service.partsUsed : [],
  hoursSpent: service.hoursSpent ?? null,
  laborCost: service.laborCost ?? null,
  partsCost: service.partsCost ?? null,
  additionalCost: service.additionalCost ?? null,
  totalServiceCost: service.totalServiceCost ?? null,
  technician: service.technician && typeof service.technician === "object"
    ? service.technician.name || [service.technician.name_first, service.technician.name_last].filter(Boolean).join(" ") || service.technician.email || ""
    : "",
  evidence: assessServiceEvidence(service),
  aiInterpretation: service.aiInterpretation?.status ? service.aiInterpretation : null,
});

const completeUnitHistory = (json, history = []) => {
  const serviceRows = history.map((service) => ({
    ...serviceHistoryItem(service),
    eventType: serviceTypeFor(service) === "installation" ? "installation" : "service",
    evidence: assessServiceEvidence(service, { installedAt: json.installation?.installedAt }),
  }));
  const serviceHistoryIds = new Set(serviceRows.map((row) => String(row.id || "")).filter(Boolean));
  if (json.installation?.installedAt && !serviceRows.some((row) => row.serviceType === "installation")) {
    serviceRows.push({
      id: `installation-${json.id || json._id || json.serialNumber}`,
      date: json.installation.installedAt,
      serviceType: "installation",
      eventType: "installation",
      findings: "AC unit installed and registered.",
      actionTaken: [json.installation.addressLine, json.installation.city, json.installation.province].filter(Boolean).join(", "),
      partsUsed: [],
    });
  }
  for (const record of json.warranty?.serviceRecords || []) {
    if (record.serviceHistoryId && serviceHistoryIds.has(String(record.serviceHistoryId))) continue;
    serviceRows.push({
      id: record.serviceHistoryId || `warranty-service-${record._id || record.serviceDate}`,
      date: record.serviceDate,
      serviceType: record.visitType === "repair" ? "repair" : "inspection",
      eventType: "warranty_service",
      findings: record.summary || "Warranty service recorded.",
      actionTaken: record.claimId ? `Warranty claim ${record.claimId}` : "",
      partsUsed: [],
    });
  }
  for (const claim of json.warranty?.claims || []) {
    serviceRows.push({
      id: `warranty-claim-${claim.claimId}`,
      date: claim.resolvedAt || claim.reviewedAt || claim.requestedAt,
      serviceType: "warranty_claim",
      eventType: "warranty_claim",
      findings: claim.issue || "Warranty claim",
      actionTaken: `Status: ${String(claim.status || "submitted").replace(/_/g, " ")}${claim.decisionNote ? ` · ${claim.decisionNote}` : ""}`,
      partsUsed: [],
    });
  }
  return serviceRows.sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0));
};

const serializeCustomerUnit = (unit, history = [], recommendation = null, product = null, sourceOrder = null) => {
  const json = unit.toJSON ? unit.toJSON() : unit;
  const productJson = product?.toJSON ? product.toJSON() : product || {};
  const productId = String(json.productId || productJson.id || productJson._id || "");
  const catalogImage = String(productJson.image || "").trim();
  const warranty = { ...(json.warranty || {}), ...getWarrantyCoverage(json.warranty || {}), status: effectiveWarrantyStatus(json.warranty || {}) };
  const bestServicedBy = recommendation ? recommendation.bestServicedBy : json.amp?.bestServicedBy || json.amp?.nextIdealServiceDate || "";
  const recommendedService = recommendation ? recommendation.recommendedService : json.amp?.recommendedService || "";
  return {
    id: json.id || String(json._id || ""), userId: String(json.customer || ""),
    productId,
    unitName: customerUnitName(json.brand || productJson.brand, json.modelName || productJson.name),
    brand: json.brand || productJson.brand || "", model: json.modelName || productJson.name || "",
    productSku: productJson.sku || "", category: json.category || productJson.category || "",
    imageUrl: catalogImage || (productId ? `/api/products/${encodeURIComponent(productId)}/image` : ""),
    capacityHp: Number(json.capacityHp || 0), roomSizeSqm: json.roomSizeSqm || null,
    serialNumber: json.serialNumber || "", qrCode: json.qrCode || "", qrUnitId: json.qrUnitId || "",
    orderCode: sourceOrder?.orderCode || "", purchaseDate: sourceOrder?.createdAt || "",
    serviceBranch: json.serviceBranch || "",
    status: json.status === "on_hold" ? "On Hold" : json.status === "retired" ? "Retired" : (recommendation ? recommendation.overdue : json.status === "service_due") ? "Service Due" : "Active",
    installationDate: json.installation?.installedAt ? formatDateKeyInTimeZone(json.installation.installedAt) : "",
    placementArea: json.installation?.addressLine || "",
    installationEnvironment: [json.installation?.city, json.installation?.province].filter(Boolean).join(", "),
    bestServicedBy, recommendedService, recommendedServiceLabel: displayService(recommendedService),
    lastServiceDate: recommendation ? recommendation.lastServiceDate : json.amp?.lastServiceDate || null,
    lastCleaningDate: recommendation ? recommendation.lastCleaningDate : json.amp?.lastCleaningDate || null,
    recommendationBasis: recommendation?.recommendationBasis || json.amp?.recommendationBasis || "",
    aiAssessment: recommendation?.aiAssessment || "",
    whyThisDate: recommendation?.whyThisDate || "",
    historicalBasis: recommendation?.historicalBasis || null,
    predictionSource: recommendation?.predictionSource || "system",
    capacityAssessment: recommendation?.capacityAssessment || json.amp?.capacityAssessment || null,
    dataQuality: recommendation?.dataQuality || json.amp?.dataQuality || null,
    overdue: Boolean(recommendation?.overdue), amp: { ...json.amp, ...(recommendation || {}), nextIdealServiceDate: bestServicedBy },
    warranty: { ...warranty, claims: Array.isArray(warranty.claims) ? warranty.claims : [], serviceRecords: Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : [], timeline: Array.isArray(warranty.timeline) ? warranty.timeline : [] },
    warrantyStatus: warranty.status || "pending_activation", warrantyExpirationDate: warranty.expirationDate || "",
    warrantyRecommendation: getWarrantyRecommendation(warranty), serviceHistory: history.map((service) => ({ ...serviceHistoryItem(service), evidence: assessServiceEvidence(service, { installedAt: json.installation?.installedAt }) })),
    unitHistory: completeUnitHistory(json, history),
    createdAt: json.createdAt, updatedAt: json.updatedAt,
  };
};

const loadAccessibleUnit = async (req) => {
  assertAmpBranch(req);
  const unit = await Unit.findById(req.params.unitId);
  if (!unit) { const error = new Error("Unit not found"); error.status = 404; throw error; }
  if (!INTERNAL_AMP_ROLES.has(req.authUser.role) && String(unit.customer || "") !== String(req.authUser._id || "")) {
    const error = new Error("Forbidden"); error.status = 403; throw error;
  }
  assertAmpBranch(req, unit);
  if (req.authUser.role === "technician") {
    const technicianTask = await Task.exists({
      assignedTechnicianId: String(req.authUser._id || ""),
      $or: [
        { unitId: String(unit._id) },
        { "payload.unitId": String(unit._id) },
        { "payload.serialNumbers": unit.serialNumber },
        { "payload.items.serialNumbers": unit.serialNumber },
        { "payload.items.serialUnits.serialNumber": unit.serialNumber },
      ],
    });
    if (!technicianTask) {
      const error = new Error("This AC unit is not part of one of your assigned work orders."); error.status = 403; throw error;
    }
  }
  return unit;
};

const notifyDueMaintenance = async (unit, recommendation) => {
  return notifyMaintenanceForUnit(unit, recommendation);
};

const calculateNextServiceDate = async (req, res) => {
  try {
    const unit = await loadAccessibleUnit(req);
    const persist = req.query.persist !== "false";
    const requestedAsOfDate = String(req.query.asOfDate || "").trim();
    if (requestedAsOfDate && (persist || req.authUser.role === "customer")) {
      return res.status(400).json({
        message: "Historical calculation dates are read-only and available only to authorized staff.",
      });
    }
    const recommendation = await calculateMaintenanceRecommendation(unit._id, {
      asOfDate: persist ? new Date() : requestedAsOfDate || new Date(),
      persist,
    });
    // Page loads and reminders use calculated records only. AI is opt-in via reports.
    const insight = {
      best_serviced_by: recommendation.bestServicedBy?.slice(0, 10) || "", recommended_service: recommendation.recommendedService,
      recommendation_summary: recommendation.recommendationBasis, capacity_assessment: recommendation.capacityAssessment.status,
    };
    if (persist && !["on_hold", "retired"].includes(unit.status)) await notifyDueMaintenance(unit, recommendation);
    return res.json({ provider: "system", recommendation, insight, warning: "" });
  } catch (error) {
    console.error("Failed to calculate AMP maintenance recommendation:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to calculate the maintenance recommendation." });
  }
};

const listMyUnits = async (req, res) => {
  try {
    const units = await Unit.find({ customer: req.authUser._id, status: { $ne: "retired" } })
      .sort({ "installation.installedAt": -1, createdAt: -1, serialNumber: 1 });
    const productIds = units
      .map((unit) => String(unit.productId || ""))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds } }).select("name sku brand category image serialUnits.serialNumber serialUnits.assignedOrderCode")
      : [];
    const productById = new Map(products.map((product) => [String(product._id), product]));
    const orderCodeBySerial = new Map();
    products.forEach((product) => (product.serialUnits || []).forEach((serialUnit) => {
      const serialNumber = String(serialUnit.serialNumber || "").trim();
      const orderCode = String(serialUnit.assignedOrderCode || "").trim();
      if (serialNumber && orderCode) orderCodeBySerial.set(serialNumber, orderCode);
    }));
    const serialNumbers = units.map((unit) => String(unit.serialNumber || "").trim()).filter(Boolean);
    const assignedOrderCodes = Array.from(new Set(serialNumbers.map((serial) => orderCodeBySerial.get(serial)).filter(Boolean)));
    const sourceOrders = serialNumbers.length
      ? await Order.find({
          customer: req.authUser._id,
          $or: [
            { "items.serialNumbers": { $in: serialNumbers } },
            { "items.serialUnits.serialNumber": { $in: serialNumbers } },
            ...(assignedOrderCodes.length ? [{ orderCode: { $in: assignedOrderCodes } }] : []),
          ],
        }).select("orderCode items.serialNumbers items.serialUnits.serialNumber createdAt").sort({ createdAt: -1 })
      : [];
    const orderBySerial = new Map();
    sourceOrders.forEach((order) => {
      const itemSerials = (order.items || []).flatMap((item) => [
        ...(item.serialNumbers || []),
        ...(item.serialUnits || []).map((serialUnit) => serialUnit?.serialNumber),
      ]).map((serial) => String(serial || "").trim()).filter(Boolean);
      serialNumbers.forEach((serial) => {
        const matchesItems = itemSerials.includes(serial);
        const matchesAssignment = orderCodeBySerial.get(serial) === String(order.orderCode || "");
        if ((matchesItems || matchesAssignment) && !orderBySerial.has(serial)) orderBySerial.set(serial, order);
      });
    });
    const histories = units.length ? await ServiceHistory.find({ unit: { $in: units.map((unit) => unit._id) } }).sort({ serviceDate: -1 }).lean() : [];
    const historyByUnit = new Map();
    histories.forEach((item) => historyByUnit.set(String(item.unit), [...(historyByUnit.get(String(item.unit)) || []), item]));
    const unitIds = units.map((unit) => String(unit._id));
    const serviceRequests = unitIds.length
      ? await ServiceRequest.find({ unitId: { $in: unitIds }, status: { $ne: "Cancelled" } })
        .select("unitId issue issueType payload status createdAt")
        .sort({ createdAt: -1 })
        .lean()
      : [];
    const requestsByUnit = new Map();
    serviceRequests.forEach((request) => requestsByUnit.set(
      String(request.unitId),
      [...(requestsByUnit.get(String(request.unitId)) || []), request],
    ));
    const cohortCache = new Map();
    // Listing customer units must be read-only. Daily monitoring owns status
    // persistence and due notifications; running those writes on every mobile
    // refresh made the dashboard slower and produced avoidable database load.
    const recommendations = await Promise.all(units.map((unit) => calculateMaintenanceRecommendation(unit._id, {
      unit,
      allHistory: historyByUnit.get(String(unit._id)) || [],
      serviceRequests: requestsByUnit.get(String(unit._id)) || [],
      cohortCache,
      persist: false,
    })));
    return res.json({
      units: units.map((unit, index) => serializeCustomerUnit(
        unit,
        historyByUnit.get(String(unit._id)) || [],
        recommendations[index],
        productById.get(String(unit.productId || "")) || null,
        orderBySerial.get(String(unit.serialNumber || "")) || null,
      )),
    });
  } catch (error) {
    console.error("Failed to list customer AMP units:", error.message);
    return res.status(500).json({ message: "Unable to load installed AC units right now." });
  }
};

const updateRoomSize = async (req, res) => {
  try {
    const unit = await loadAccessibleUnit(req);
    const roomSizeSqm = Number(req.body?.roomSizeSqm);
    if (!Number.isFinite(roomSizeSqm) || roomSizeSqm <= 0 || roomSizeSqm > 10000) return res.status(400).json({ message: "Enter a valid room size in square meters." });
    unit.roomSizeSqm = roomSizeSqm; await unit.save();
    const recommendation = await calculateMaintenanceRecommendation(unit._id);
    const [history, product] = await Promise.all([ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }), mongoose.isValidObjectId(unit.productId) ? Product.findById(unit.productId).select("name sku brand category image") : null]);
    return res.json({ message: "Room size saved.", recommendation, unit: serializeCustomerUnit(unit, history, recommendation, product) });
  } catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to update room size." }); }
};

const completeService = async (req, res) => {
  try {
    const unit = await loadAccessibleUnit(req);
    const taskId = String(req.body?.taskId || "");
    if (!mongoose.isValidObjectId(taskId)) return res.status(409).json({ message: "Complete the service report from its assigned work order so check-in, service history, and request status stay synchronized." });
    const task = await Task.findById(taskId);
    if (!task || String(task.unitId || task.payload?.unitId || "") !== String(unit._id)) return res.status(403).json({ message: "This work order does not belong to the selected AC unit." });
    req.params.taskId = taskId;
    req.body = { ...req.body, status: "completed" };
    return require("./taskController").updateTaskStatus(req, res);
  } catch (error) {
    console.error("Failed to complete service:", error.message);
    return res.status(error.status || 500).json({ message: error.message || "Unable to complete service.", errors: error.errors || null });
  }
};

const getManagerPipeline = async (req, res) => {
  try {
    const scope = resolveManagerPipelineScope({
      role: req.authUser.role,
      requestedBranch: req.query.branch,
      activeBranch: req.activeBranch,
    });
    return res.json(await getManagerServicePipeline({ days: req.query.days, page: req.query.page, pageSize: req.query.pageSize, ...scope }));
  }
  catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to load the maintenance pipeline." }); }
};
const getReportUnits = async (req, res) => {
  try {
    assertAmpBranch(req);
    const branch = req.authUser.role === "superadmin" || req.authUser.role === "owner" ? "" : req.activeBranch;
    const query = { status: { $ne: "retired" } };
    if (branch) query.serviceBranch = branch;
    const units = await Unit.find(query)
      .select("brand modelName serialNumber serviceBranch status customer customerName capacityHp")
      .populate("customer", "name name_first name_last")
      .sort({ serviceBranch: 1, modelName: 1, serialNumber: 1 })
      .lean();
    return res.json({
      units: units.map((unit) => ({
        unitId: String(unit._id),
        customerName: unit.customer?.name || [unit.customer?.name_first, unit.customer?.name_last].filter(Boolean).join(" ") || unit.customerName || "Customer name not recorded",
        capacityHp: unit.capacityHp || null,
        modelName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
        serialNumber: unit.serialNumber || "",
        branch: unit.serviceBranch || "Unassigned",
        status: unit.status || "active",
      })),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.status === 403 ? error.message : "Unable to load AMP report units." });
  }
};
const getOwnerForecast = async (req, res) => {
  try { return res.json(await getOwnerServiceForecast({ months: req.query.months, averageRevenue: req.query.averageRevenue })); }
  catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to load the maintenance forecast." }); }
};

module.exports = { listMyUnits, calculateNextServiceDate, updateRoomSize, completeService, getManagerPipeline, getReportUnits, getOwnerForecast, resolveManagerPipelineScope, serializeCustomerUnit };
