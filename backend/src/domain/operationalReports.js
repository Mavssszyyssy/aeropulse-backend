const { BRANCHES } = require("./branchRouting");
const { orderIsPaid } = require("./orderPayment");

const DAY_MS = 24 * 60 * 60 * 1000;
const SALES_STATUSES = ["all", "paid", "complete", "to_pay", "to_deliver", "to_dispatch", "to_install", "for_rescheduling", "cancelled"];
const SALES_PAYMENT_METHODS = ["all", "cod", "gcash", "card"];

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const validDate = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseReportDate = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const normalized = String(value).trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  if (endOfDay && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
};

const resolveReportRange = ({ from, to } = {}, now = new Date()) => {
  const fallbackTo = new Date(now);
  const resolvedTo = parseReportDate(to, { endOfDay: true }) || fallbackTo;
  const resolvedFrom = parseReportDate(from) || new Date(resolvedTo.getTime() - 30 * DAY_MS);
  if (resolvedFrom > resolvedTo) {
    const error = new Error("The report start date must be on or before the end date.");
    error.statusCode = 400;
    throw error;
  }
  return { from: resolvedFrom, to: resolvedTo };
};

const normalizeSalesStatus = (value = "paid") => {
  const status = String(value || "paid").trim().toLowerCase();
  if (!SALES_STATUSES.includes(status)) {
    const error = new Error("Unsupported report status filter.");
    error.statusCode = 400;
    throw error;
  }
  return status;
};

const normalizePaymentMethodFilter = (value = "all") => {
  const method = String(value || "all").trim().toLowerCase();
  if (!SALES_PAYMENT_METHODS.includes(method)) {
    const error = new Error("Unsupported payment method filter.");
    error.statusCode = 400;
    throw error;
  }
  return method;
};

const canonicalPaymentMethod = (value = "") => {
  const method = String(value || "").trim().toLowerCase();
  if (method === "cod") return "cod";
  if (method === "gcash") return "gcash";
  if (["card", "credit", "credit_card"].includes(method)) return "card";
  return method;
};

const filterSalesOrders = (orders = [], { paymentMethod = "all", search = "" } = {}) => {
  const normalizedMethod = normalizePaymentMethodFilter(paymentMethod);
  const needle = String(search || "").trim().toLowerCase();
  return (orders || []).filter((order) => {
    if (normalizedMethod !== "all" && canonicalPaymentMethod(order.paymentMethod) !== normalizedMethod) return false;
    if (!needle) return true;
    return [
      order.orderCode,
      order.customerName,
      ...(order.items || []).flatMap((item) => [item.sku, item.productSku, item.name, item.model]),
    ].some((value) => String(value || "").toLowerCase().includes(needle));
  });
};

const filterInventoryRows = (rows = [], { category = "all", brand = "" } = {}) => {
  const normalizedCategory = String(category || "all").trim().toLowerCase();
  const normalizedBrand = String(brand || "").trim().toLowerCase();
  return (rows || []).filter((row) => (
    (normalizedCategory === "all" || String(row.category || "").trim().toLowerCase() === normalizedCategory)
    && (!normalizedBrand || String(row.brand || "").toLowerCase().includes(normalizedBrand))
  ));
};

const buildTechnicianPerformanceReport = (technicians = [], completedTasks = [], { search = "" } = {}) => {
  const needle = String(search || "").trim().toLowerCase();
  const completions = new Map();
  (completedTasks || []).forEach((task) => {
    const technicianId = String(task.assignedTechnicianId || "");
    if (technicianId) completions.set(technicianId, (completions.get(technicianId) || 0) + 1);
  });
  const rows = (technicians || []).map((technician) => ({
    technician: technician.name || [technician.name_first, technician.name_last].filter(Boolean).join(" ") || technician.email || "Technician",
    branch: technician.activeBranch || technician.assignedBranch || "Unassigned",
    completedWorkOrders: completions.get(String(technician._id || technician.id || "")) || 0,
  })).filter((row) => !needle || [row.technician, row.branch]
    .some((value) => String(value || "").toLowerCase().includes(needle)))
    .sort((left, right) => right.completedWorkOrders - left.completedWorkOrders || left.technician.localeCompare(right.technician));
  return {
    summary: {
      technicianCount: rows.length,
      completedInPeriod: rows.reduce((sum, row) => sum + row.completedWorkOrders, 0),
    },
    rows,
  };
};

const normalizeInterval = (value = "daily") => {
  const interval = String(value || "daily").trim().toLowerCase();
  if (["week", "weekly"].includes(interval)) return "weekly";
  if (["month", "monthly"].includes(interval)) return "monthly";
  return "daily";
};

const orderMatchesSalesStatus = (order = {}, status = "paid") => {
  const workflow = String(order.workflowStatus || "").toLowerCase();
  const paid = orderIsPaid(order);
  if (status === "all") return workflow !== "cancelled";
  if (status === "paid") return paid && workflow !== "cancelled";
  if (status === "complete") return paid && workflow === "complete";
  return workflow === status;
};

const paidAt = (order = {}) => validDate(
  order.paymongo?.paidAt
  || order.codCollection?.collectedAt
  || order.receipt?.issuedAt,
);

const orderReportDate = (order = {}, status = "paid") => {
  const usePaymentDate = status === "paid" || status === "complete";
  return (usePaymentDate ? paidAt(order) : null)
    || validDate(order.createdAt)
    || validDate(order.updatedAt);
};

const itemSubtotal = (order = {}) => roundMoney((order.items || []).reduce(
  (total, item) => total + Math.max(0, Number(item.quantity || 0)) * Math.max(0, Number(item.price || 0)),
  0,
));

const normalizedOrderTotals = (order = {}) => {
  const calculatedSubtotal = itemSubtotal(order);
  const storedSubtotal = finiteNumber(order.subtotalAmount ?? order.receipt?.subtotalAmount);
  const subtotal = storedSubtotal !== null && (storedSubtotal > 0 || calculatedSubtotal === 0)
    ? storedSubtotal
    : calculatedSubtotal;
  const vat = Math.max(0, finiteNumber(order.vatAmount ?? order.receipt?.vatAmount) || 0);
  const deliveryFee = Math.max(0, finiteNumber(order.shippingFee ?? order.receipt?.shippingFee) || 0);
  const discount = Math.max(0, finiteNumber(order.discountAmount ?? order.receipt?.discountAmount) || 0);
  const calculatedTotal = roundMoney(Math.max(0, subtotal + vat + deliveryFee - discount));
  const storedTotal = finiteNumber(order.totalAmount);
  const total = storedTotal !== null && (storedTotal > 0 || calculatedTotal === 0) ? storedTotal : calculatedTotal;
  const recordedCollection = finiteNumber(order.receipt?.amountPaid)
    || finiteNumber(order.codCollection?.amount);
  const amountCollected = orderIsPaid(order) ? Math.max(0, recordedCollection || total) : 0;
  return {
    subtotal: roundMoney(subtotal),
    vat: roundMoney(vat),
    deliveryFee: roundMoney(deliveryFee),
    discount: roundMoney(discount),
    total: roundMoney(total),
    amountCollected: roundMoney(amountCollected),
  };
};

const salesBucket = (date, interval) => {
  const bucket = new Date(date);
  bucket.setUTCHours(0, 0, 0, 0);
  if (interval === "weekly") {
    const day = bucket.getUTCDay() || 7;
    bucket.setUTCDate(bucket.getUTCDate() - day + 1);
  } else if (interval === "monthly") {
    bucket.setUTCDate(1);
  }
  return bucket.toISOString();
};

const paymentMethodLabel = (value = "") => {
  const method = String(value || "").trim().toLowerCase();
  if (method === "cod") return "Cash on Delivery";
  if (method === "gcash") return "GCash";
  if (["card", "credit", "credit_card"].includes(method)) return "Credit / debit card";
  return method ? method.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Not recorded";
};

const itemSku = (item = {}) => String(
  item.sku || item.productSku || item.model || "",
).trim();

const summarizeSalesOrders = (orders = [], options = {}) => {
  const status = normalizeSalesStatus(options.status);
  const interval = normalizeInterval(options.interval);
  const from = validDate(options.from) || new Date(0);
  const to = validDate(options.to) || new Date(8640000000000000);
  const accepted = (orders || []).map((order) => ({ order, date: orderReportDate(order, status) }))
    .filter(({ order, date }) => date && date >= from && date <= to && orderMatchesSalesStatus(order, status));
  const summary = {
    transactionCount: 0,
    unitsSold: 0,
    merchandiseSubtotal: 0,
    vatAmount: 0,
    deliveryFees: 0,
    discounts: 0,
    totalOrderValue: 0,
    amountCollected: 0,
  };
  const buckets = new Map();
  const products = new Map();
  const transactions = accepted.map(({ order, date }) => {
    const totals = normalizedOrderTotals(order);
    const units = (order.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);
    summary.transactionCount += 1;
    summary.unitsSold += units;
    summary.merchandiseSubtotal += totals.subtotal;
    summary.vatAmount += totals.vat;
    summary.deliveryFees += totals.deliveryFee;
    summary.discounts += totals.discount;
    summary.totalOrderValue += totals.total;
    summary.amountCollected += totals.amountCollected;

    const key = salesBucket(date, interval);
    const existingBucket = buckets.get(key) || { bucket: key, transactionCount: 0, unitsSold: 0, orderValue: 0, amountCollected: 0 };
    existingBucket.transactionCount += 1;
    existingBucket.unitsSold += units;
    existingBucket.orderValue += totals.total;
    existingBucket.amountCollected += totals.amountCollected;
    buckets.set(key, existingBucket);

    for (const item of order.items || []) {
      const productKey = String(item.productId || `${item.name || "Unidentified product"}|${item.model || ""}`);
      const current = products.get(productKey) || {
        productId: String(item.productId || ""),
        sku: itemSku(item),
        name: String(item.name || "Unidentified product"),
        model: String(item.model || item.specs || ""),
        unitsSold: 0,
        merchandiseSales: 0,
      };
      if (!current.sku) current.sku = itemSku(item);
      current.unitsSold += Math.max(0, Number(item.quantity || 0));
      current.merchandiseSales += Math.max(0, Number(item.quantity || 0)) * Math.max(0, Number(item.price || 0));
      products.set(productKey, current);
    }

    const skus = [...new Set((order.items || []).map(itemSku).filter(Boolean))];
    return {
      transactionDate: date.toISOString(),
      orderCode: String(order.orderCode || order._id || order.id || ""),
      sku: skus.join(", ") || "Not recorded",
      customer: String(order.customerName || "Not recorded"),
      branch: String(order.stockSourceBranch || order.customerBranch || "Unassigned"),
      paymentMethod: paymentMethodLabel(order.paymentMethod),
      paymentStatus: orderIsPaid(order) ? "Paid" : String(order.paymentStatus || "Pending").replace(/_/g, " "),
      orderStatus: String(order.workflowStatus || "Pending").replace(/_/g, " "),
      units,
      ...totals,
    };
  });

  Object.keys(summary).forEach((key) => {
    if (key !== "transactionCount" && key !== "unitsSold") summary[key] = roundMoney(summary[key]);
  });
  return {
    status,
    interval,
    summary,
    series: [...buckets.values()].map((row) => ({
      ...row,
      orderValue: roundMoney(row.orderValue),
      amountCollected: roundMoney(row.amountCollected),
      revenue: roundMoney(row.amountCollected),
    })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
    products: [...products.values()].map((row) => ({ ...row, merchandiseSales: roundMoney(row.merchandiseSales), revenue: roundMoney(row.merchandiseSales) }))
      .sort((a, b) => b.unitsSold - a.unitsSold || a.name.localeCompare(b.name)),
    transactions: transactions.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)),
  };
};

const mapValue = (map, key) => {
  if (!map) return 0;
  return Number(typeof map.get === "function" ? map.get(key) : map[key]) || 0;
};

const summarizeInventoryProducts = (products = [], selectedBranches = BRANCHES) => {
  const rows = [];
  for (const product of products || []) {
    for (const branch of selectedBranches) {
      const currentStock = Math.max(0, mapValue(product.branchStock, branch));
      const threshold = Math.max(0, mapValue(product.branchThresholds, branch) || Number(product.threshold || 0));
      const units = (product.serialUnits || []).filter((unit) => String(unit.branch || "") === branch);
      const counts = ["available", "assigned", "sold", "service", "retired"].reduce((result, state) => ({
        ...result,
        [state]: units.filter((unit) => String(unit.status || "available") === state).length,
      }), {});
      const stockStatus = currentStock === 0 ? "Out of stock" : threshold > 0 && currentStock <= threshold ? "Low stock" : "In stock";
      rows.push({
        branch,
        brand: String(product.brand || "Unspecified"),
        category: String(product.category || "Unspecified"),
        sku: String(product.sku || ""),
        product: String(product.name || ""),
        model: String(product.specs || ""),
        unitPrice: Math.max(0, Number(product.price || 0)),
        currentStock,
        availableSerials: counts.available,
        soldUnits: counts.sold,
        stockValue: roundMoney(currentStock * Math.max(0, Number(product.price || 0))),
        stockStatus,
      });
    }
  }
  rows.sort((a, b) => a.branch.localeCompare(b.branch) || a.brand.localeCompare(b.brand) || a.category.localeCompare(b.category) || a.product.localeCompare(b.product));
  const summary = {
    productLines: rows.length,
    currentStockUnits: rows.reduce((sum, row) => sum + row.currentStock, 0),
    inventoryValue: roundMoney(rows.reduce((sum, row) => sum + row.stockValue, 0)),
    outOfStockItems: rows.filter((row) => row.stockStatus === "Out of stock").length,
    lowStockItems: rows.filter((row) => row.stockStatus === "Low stock").length,
  };
  return { summary, rows };
};

module.exports = {
  SALES_PAYMENT_METHODS,
  SALES_STATUSES,
  buildTechnicianPerformanceReport,
  filterInventoryRows,
  filterSalesOrders,
  normalizeInterval,
  normalizePaymentMethodFilter,
  normalizeSalesStatus,
  normalizedOrderTotals,
  orderIsPaid,
  orderReportDate,
  resolveReportRange,
  summarizeInventoryProducts,
  summarizeSalesOrders,
};
