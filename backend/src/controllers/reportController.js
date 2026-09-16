const Order = require("../models/Order");
const Product = require("../models/Product");
const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const Task = require("../models/Task");
const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const { BRANCHES } = require("../domain/branchRouting");
const { isNonRetailCatalogProduct } = require("../domain/catalogVisibility");
const { activeTechnicianQuery } = require("./dashboardController");
const {
  buildTechnicianPerformanceReport,
  filterInventoryRows,
  filterSalesOrders,
  normalizeInterval,
  normalizePaymentMethodFilter,
  normalizeSalesStatus,
  resolveReportRange,
  summarizeInventoryProducts,
  summarizeSalesOrders,
} = require("../domain/operationalReports");
const { buildBusinessIntelligence } = require("../domain/businessIntelligence");
const { callStructuredAmpAnalysis, resolveBusinessIntelligence } = require("../services/openAiAmpService");

const reportTextFilter = (value, { label = "Report filter", maxLength = 100 } = {}) => {
  const text = String(value || "").trim();
  if (text.length > maxLength) {
    const error = new Error(`${label} must be ${maxLength} characters or fewer.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
};

const reportBranch = (req, { allowAll = true } = {}) => {
  if (req.authUser?.role !== "superadmin") return String(req.activeBranch || "");
  const requested = String(req.query.branch || "all").trim();
  if (allowAll && (!requested || requested.toLowerCase() === "all")) return "";
  if (!BRANCHES.includes(requested)) {
    const error = new Error("Select a valid branch for this report.");
    error.statusCode = 400;
    throw error;
  }
  return requested;
};

const getReportFilterOptions = async (req, res) => {
  try {
    const { from, to } = resolveReportRange(req.query);
    const activeBranch = reportBranch(req);
    const orderConditions = [{ $or: [
      { createdAt: { $gte: from, $lte: to } },
      { updatedAt: { $gte: from, $lte: to } },
      { "paymongo.paidAt": { $gte: from, $lte: to } },
      { "codCollection.collectedAt": { $gte: from, $lte: to } },
    ] }];
    if (activeBranch) {
      orderConditions.push({ $or: [
        { stockSourceBranch: activeBranch },
        { stockSourceBranch: "", customerBranch: activeBranch },
      ] });
    }

    const [customerNames, technicians, catalog] = await Promise.all([
      Order.distinct("customerName", { $and: orderConditions }),
      User.find(activeTechnicianQuery(activeBranch))
        .select("name name_first name_last email activeBranch assignedBranch")
        .sort({ name: 1, name_first: 1, name_last: 1 })
        .lean(),
      Product.find({ isActive: { $ne: false } }).select("name sku brand isActive").lean(),
    ]);
    const products = catalog.filter((product) => !isNonRetailCatalogProduct(product));
    const uniqueSorted = (values) => [...new Set(values
      .map((value) => String(value || "").trim())
      .filter(Boolean))].sort((left, right) => left.localeCompare(right));

    return res.json({
      branch: activeBranch || "all",
      from: from.toISOString(),
      to: to.toISOString(),
      customers: uniqueSorted(customerNames),
      technicians: technicians.map((technician) => ({
        value: String(technician._id),
        label: technician.name
          || `${technician.name_first || ""} ${technician.name_last || ""}`.trim()
          || technician.email
          || "Technician",
        branch: technician.activeBranch || technician.assignedBranch || "",
      })),
      skus: uniqueSorted(products.map((product) => product.sku)),
      brands: uniqueSorted(products.map((product) => product.brand)),
    });
  } catch (error) {
    console.error("Failed to load report filter options:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load report filters right now." });
  }
};

const getSalesReport = async (req, res) => {
  try {
    const interval = normalizeInterval(req.query.interval);
    const status = normalizeSalesStatus(req.query.status);
    const paymentMethod = normalizePaymentMethodFilter(req.query.paymentMethod);
    const search = reportTextFilter(req.query.search, { label: "Sales search" });
    const sku = reportTextFilter(req.query.sku, { label: "Sales SKU", maxLength: 80 });
    const customer = reportTextFilter(req.query.customer, { label: "Sales customer", maxLength: 100 });
    const { from, to } = resolveReportRange(req.query);
    const topN = Math.min(50, Math.max(1, Number(req.query.topN) || 10));
    const activeBranch = reportBranch(req);
    const conditions = [{ $or: [
      { createdAt: { $gte: from, $lte: to } },
      { updatedAt: { $gte: from, $lte: to } },
      { "paymongo.paidAt": { $gte: from, $lte: to } },
      { "codCollection.collectedAt": { $gte: from, $lte: to } },
    ] }];
    if (activeBranch) {
      conditions.push({ $or: [
        { stockSourceBranch: activeBranch },
        { stockSourceBranch: "", customerBranch: activeBranch },
      ] });
    }
    // Payment can occur after order creation, particularly for COD. Read every
    // order whose creation, update, or recorded payment overlaps the period,
    // then apply the exact reporting date and status rule once in the domain.
    const orders = await Order.find({ $and: conditions }).lean();
    // New orders retain their SKU directly. Older orders used the `model`
    // field for the catalog SKU, so prefer the linked product record and keep
    // that stored value only as a compatibility fallback.
    const productIds = [...new Set(orders.flatMap((order) => (order.items || [])
      .map((item) => String(item.productId || "").trim())
      .filter((id) => /^[a-f\d]{24}$/i.test(id))))];
    const catalogProducts = productIds.length
      ? await Product.find({ _id: { $in: productIds } }).select("_id sku").lean()
      : [];
    const skuByProductId = new Map(catalogProducts.map((product) => [String(product._id), String(product.sku || "").trim()]));
    const ordersWithSkus = orders.map((order) => ({
      ...order,
      items: (order.items || []).map((item) => ({
        ...item,
        sku: String(item.sku || skuByProductId.get(String(item.productId || "")) || item.productSku || item.model || "").trim(),
      })),
    }));
    const filteredOrders = filterSalesOrders(ordersWithSkus, { paymentMethod, search, sku, customer });
    const report = summarizeSalesOrders(filteredOrders, { status, interval, from, to });
    return res.json({
      interval: report.interval,
      status: report.status,
      paymentMethod,
      search,
      sku,
      customer,
      from: from.toISOString(),
      to: to.toISOString(),
      branch: activeBranch || "all",
      updatedAt: new Date().toISOString(),
      basis: status === "paid" || status === "complete"
        ? "Stored, non-cancelled paid transactions dated by confirmed payment; legacy paid records without a payment timestamp use their recorded order date."
        : "Stored orders dated by their recorded order date. Paid and unpaid amounts remain separate.",
      summary: report.summary,
      series: report.series,
      products: report.products.slice(0, topN),
      topProducts: report.products.slice(0, topN),
      transactions: report.transactions,
    });
  } catch (error) {
    console.error("Failed to load sales report:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load the sales report right now." });
  }
};

const inventorySummary = (rows) => ({
  productLines: rows.length,
  currentStockUnits: rows.reduce((sum, row) => sum + row.currentStock, 0),
  inventoryValue: Math.round(rows.reduce((sum, row) => sum + row.stockValue, 0) * 100) / 100,
  outOfStockItems: rows.filter((row) => row.stockStatus === "Out of stock").length,
  lowStockItems: rows.filter((row) => row.stockStatus === "Low stock").length,
});

const getInventoryReport = async (req, res) => {
  try {
    const activeBranch = reportBranch(req);
    const branches = activeBranch ? [activeBranch] : BRANCHES;
    const products = (await Product.find({ isActive: { $ne: false } })
      .select("name sku brand category specs price stock branchStock threshold branchThresholds serialUnits isActive")
      .lean())
      .filter((product) => !isNonRetailCatalogProduct(product));
    const report = summarizeInventoryProducts(products, branches);
    const stockFilter = String(req.query.stock || "all").trim().toLowerCase();
    if (!["all", "out", "low", "available"].includes(stockFilter)) {
      return res.status(400).json({ message: "Unsupported inventory stock filter." });
    }
    const search = reportTextFilter(req.query.search, { label: "Inventory search" }).toLowerCase();
    const category = reportTextFilter(req.query.category || "all", { label: "Inventory category", maxLength: 40 }).toLowerCase();
    const brand = reportTextFilter(req.query.brand, { label: "Inventory brand", maxLength: 60 });
    const sku = reportTextFilter(req.query.sku, { label: "Inventory SKU", maxLength: 80 });
    const stockRows = report.rows.filter((row) => {
      const stockMatches = stockFilter === "all"
        || (stockFilter === "out" && row.stockStatus === "Out of stock")
        || (stockFilter === "low" && row.stockStatus === "Low stock")
        || (stockFilter === "available" && row.currentStock > 0);
      const searchMatches = !search || [row.brand, row.category, row.sku, row.product, row.model, row.branch]
        .some((value) => String(value || "").toLowerCase().includes(search));
      return stockMatches && searchMatches;
    });
    const rows = filterInventoryRows(stockRows, { category, brand, sku });
    return res.json({
      branch: activeBranch || "all",
      stockFilter,
      search,
      category,
      brand,
      sku,
      updatedAt: new Date().toISOString(),
      basis: "Current stock and available serial/QR unit records for the selected branch.",
      summary: inventorySummary(rows),
      rows,
    });
  } catch (error) {
    console.error("Failed to load inventory report:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load the inventory report right now." });
  }
};

const getTechnicianReport = async (req, res) => {
  try {
    const { from, to } = resolveReportRange(req.query);
    const activeBranch = reportBranch(req);
    const search = reportTextFilter(req.query.search, { label: "Technician search" });
    const technician = reportTextFilter(req.query.technician, { label: "Technician filter", maxLength: 50 });
    if (technician && !/^[a-f\d]{24}$/i.test(technician)) {
      return res.status(400).json({ message: "Select a valid technician for this report." });
    }
    const technicianQuery = activeTechnicianQuery(activeBranch);
    if (technician) technicianQuery._id = technician;
    const technicians = await User.find(technicianQuery)
      .select("name name_first name_last email activeBranch assignedBranch")
      .sort({ name: 1, name_first: 1, name_last: 1 })
      .lean();
    const technicianIds = technicians.map((technician) => String(technician._id));
    const completedTaskQuery = {
      assignedTechnicianId: { $in: technicianIds },
      status: "completed",
      completedAt: { $gte: from, $lte: to },
    };
    if (activeBranch) completedTaskQuery.branch = activeBranch;
    const completedTasks = technicianIds.length
      ? await Task.find(completedTaskQuery).select("assignedTechnicianId completedAt branch").lean()
      : [];
    const report = buildTechnicianPerformanceReport(technicians, completedTasks, { search });
    return res.json({
      branch: activeBranch || "all",
      from: from.toISOString(),
      to: to.toISOString(),
      search,
      technician,
      updatedAt: new Date().toISOString(),
      basis: "Completed work orders within the selected reporting period for active technician accounts only.",
      summary: report.summary,
      rows: report.rows,
    });
  } catch (error) {
    console.error("Failed to load technician report:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load the technician report right now." });
  }
};

const getBusinessIntelligence = async (req, res) => {
  try {
    const { from, to } = resolveReportRange(req.query);
    const activeBranch = reportBranch(req);
    const duration = Math.max(1, to.getTime() - from.getTime());
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - duration);
    const branchOrderConditions = activeBranch ? [{ $or: [
      { stockSourceBranch: activeBranch },
      { stockSourceBranch: "", customerBranch: activeBranch },
    ] }] : [];
    const orderDateCondition = { $or: [
      { createdAt: { $gte: previousFrom, $lte: to } },
      { updatedAt: { $gte: previousFrom, $lte: to } },
      { "paymongo.paidAt": { $gte: previousFrom, $lte: to } },
      { "codCollection.collectedAt": { $gte: previousFrom, $lte: to } },
      { "receipt.issuedAt": { $gte: previousFrom, $lte: to } },
    ] };
    const unitQuery = activeBranch ? { serviceBranch: activeBranch } : {};
    const [orders, catalog, units] = await Promise.all([
      Order.find({ $and: [orderDateCondition, ...branchOrderConditions] }).lean(),
      Product.find({ isActive: { $ne: false } }).select("name sku brand category specs price stock branchStock threshold branchThresholds serialUnits isActive").lean(),
      Unit.find(unitQuery).select("brand modelName category capacityHp serviceBranch status installation.installedAt amp").lean(),
    ]);
    const products = catalog.filter((product) => !isNonRetailCatalogProduct(product));
    const unitIds = units.map((unit) => unit._id);
    const histories = unitIds.length ? await ServiceHistory.find({
      unit: { $in: unitIds },
      serviceDate: { $gte: from, $lte: to },
    }).select("unit serviceDate serviceType visitType findings actionTaken partsUsed conditionRating technicianInputs customerInputs serviceActions").lean() : [];
    const intelligence = buildBusinessIntelligence({
      orders,
      products,
      histories,
      units: units.filter((unit) => unit.status !== "retired"),
      branches: activeBranch ? [activeBranch] : BRANCHES,
      from,
      to,
      previousFrom,
      previousTo,
    });
    const ai = await callStructuredAmpAnalysis({
      businessIntelligence: true,
      safetyIdentifier: String(req.authUser._id),
      intelligenceFacts: intelligence.facts,
    });
    const resolved = resolveBusinessIntelligence(intelligence.facts, ai);
    return res.json({
      branch: activeBranch || "all",
      from: from.toISOString(),
      to: to.toISOString(),
      updatedAt: new Date().toISOString(),
      basis: "Verified paid orders, completed service records, current branch stock, and saved unit-level AMP schedules in AEROPULSE.",
      provider: resolved.provider,
      warning: resolved.warning,
      summary: intelligence.summary,
      charts: intelligence.charts,
      tables: intelligence.tables,
      insights: resolved.insights,
    });
  } catch (error) {
    console.error("Failed to load business intelligence:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load business intelligence right now." });
  }
};

const getAuditLogs = async (req, res) => {
  try {
    const { from, to } = resolveReportRange(req.query);
    const userFilter = String(req.query.user || "").trim();
    const actionFilter = String(req.query.action || "").trim();
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const match = { createdAt: { $gte: from, $lte: to } };
    if (userFilter) match.user = userFilter;
    if (actionFilter) match.action = actionFilter;
    const activeBranch = req.authUser?.role === "superadmin" ? "" : String(req.activeBranch || "");
    if (activeBranch) match.branch = activeBranch;
    const logs = await AuditLog.find(match).populate("user", "name email").sort({ createdAt: -1 }).limit(limit).skip(skip).lean();
    const total = await AuditLog.countDocuments(match);
    return res.json({
      logs: logs.map((log) => ({
        id: log._id.toString(), action: log.action,
        user: log.user ? `${log.user.name} (${log.user.email})` : "Unknown",
        branch: log.branch, entityType: log.entityType, entityId: log.entityId,
        changeDetails: log.changeDetails, description: log.description,
        ipAddress: log.ipAddress, timestamp: log.createdAt.toISOString(),
      })),
      total, from: from.toISOString(), to: to.toISOString(), branch: activeBranch || "all", limit, skip,
    });
  } catch (error) {
    console.error("Failed to load audit logs:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load audit logs right now." });
  }
};

module.exports = { getReportFilterOptions, getSalesReport, getInventoryReport, getTechnicianReport, getBusinessIntelligence, getAuditLogs, reportTextFilter };
