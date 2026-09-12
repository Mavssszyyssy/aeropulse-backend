const Order = require("../models/Order");
const Product = require("../models/Product");
const AuditLog = require("../models/AuditLog");
const { BRANCHES } = require("../domain/branchRouting");
const { isNonRetailCatalogProduct } = require("../domain/catalogVisibility");
const {
  normalizeInterval,
  normalizeSalesStatus,
  resolveReportRange,
  summarizeInventoryProducts,
  summarizeSalesOrders,
} = require("../domain/operationalReports");

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

const getSalesReport = async (req, res) => {
  try {
    const interval = normalizeInterval(req.query.interval);
    const status = normalizeSalesStatus(req.query.status);
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
    const report = summarizeSalesOrders(ordersWithSkus, { status, interval, from, to });
    return res.json({
      interval: report.interval,
      status: report.status,
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
  inventoryVarianceItems: rows.filter((row) => row.inventoryVariance !== 0).length,
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
    const search = String(req.query.search || "").trim().toLowerCase();
    const rows = report.rows.filter((row) => {
      const stockMatches = stockFilter === "all"
        || (stockFilter === "out" && row.stockStatus === "Out of stock")
        || (stockFilter === "low" && row.stockStatus === "Low stock")
        || (stockFilter === "available" && row.currentStock > 0);
      const searchMatches = !search || [row.brand, row.category, row.sku, row.product, row.model, row.branch]
        .some((value) => String(value || "").toLowerCase().includes(search));
      return stockMatches && searchMatches;
    });
    return res.json({
      branch: activeBranch || "all",
      stockFilter,
      search,
      updatedAt: new Date().toISOString(),
      basis: "Current assigned-branch stock and serial/QR unit records. Inventory variance is current stock minus available serial records.",
      summary: inventorySummary(rows),
      rows,
    });
  } catch (error) {
    console.error("Failed to load inventory report:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Unable to load the inventory report right now." });
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

module.exports = { getSalesReport, getInventoryReport, getAuditLogs };
