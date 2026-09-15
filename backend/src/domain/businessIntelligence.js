const { summarizeSalesOrders, summarizeInventoryProducts } = require("./operationalReports");
const { serviceTypeFor } = require("./serviceEvidence");
const { codesFor } = require("./ampMaintenanceSignals");

const round = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const date = (value) => {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
};
const percent = (value, total) => total > 0 ? round((value / total) * 100) : null;
const label = (value) => String(value || "Not recorded").trim() || "Not recorded";
const serviceLabels = {
  regular_cleaning: "regular cleaning",
  deep_cleaning: "deep cleaning",
  repair: "repair",
  inspection: "inspection",
  installation: "installation",
};
const signalLabels = {
  filter_dirt: "dirty or blocked air filters",
  coil_dirt: "dirty or blocked coils",
  deep_cleaning: "deep-cleaning requirements",
  coil_maintenance: "coil maintenance",
  refrigerant_issue: "refrigerant-related concerns",
};

const addFact = (facts, category, id, statement, action = "", weight = 0) => {
  facts[id] = { id, category, statement, action, weight };
};

const productIdentity = (item = {}, productsById = new Map()) => {
  const product = productsById.get(String(item.productId || "")) || {};
  return {
    name: label(item.name || product.name),
    model: label(item.model || item.specs || product.specs || item.name || product.name),
    brand: label(item.brand || product.brand),
    sku: label(item.sku || item.productSku || product.sku),
  };
};

const salesBreakdown = (orders, products, range) => {
  const report = summarizeSalesOrders(orders, { status: "paid", interval: "monthly", ...range });
  const productsById = new Map(products.map((product) => [String(product._id || product.id), product]));
  const brands = new Map();
  const models = new Map();
  report.transactions.forEach((transaction) => {
    const order = orders.find((candidate) => String(candidate.orderCode || candidate._id || candidate.id) === transaction.orderCode);
    (order?.items || []).forEach((item) => {
      const identity = productIdentity(item, productsById);
      const quantity = Math.max(0, Number(item.quantity || 0));
      const modelKey = `${identity.brand}|${identity.model}|${identity.sku}`;
      const currentModel = models.get(modelKey) || { ...identity, unitsSold: 0, sales: 0 };
      currentModel.unitsSold += quantity;
      currentModel.sales += quantity * Math.max(0, Number(item.price || 0));
      models.set(modelKey, currentModel);
      brands.set(identity.brand, (brands.get(identity.brand) || 0) + quantity);
    });
  });
  return {
    ...report,
    models: [...models.values()].map((item) => ({ ...item, sales: round(item.sales) }))
      .sort((left, right) => right.unitsSold - left.unitsSold || left.model.localeCompare(right.model)),
    brands: [...brands.entries()].map(([brand, unitsSold]) => ({ brand, unitsSold }))
      .sort((left, right) => right.unitsSold - left.unitsSold || left.brand.localeCompare(right.brand)),
  };
};

const serviceBreakdown = (histories, units) => {
  const unitsById = new Map(units.map((unit) => [String(unit._id || unit.id), unit]));
  const byType = new Map();
  const byModel = new Map();
  const issueSignals = new Map();
  const parts = new Map();
  const trend = new Map();
  histories.forEach((history) => {
    const type = serviceTypeFor(history);
    byType.set(type, (byType.get(type) || 0) + 1);
    const unit = unitsById.get(String(history.unit || ""));
    const model = [unit?.brand, unit?.modelName || unit?.model].filter(Boolean).join(" ") || "Unit model not recorded";
    byModel.set(model, (byModel.get(model) || 0) + 1);
    new Set(codesFor(history)).forEach((code) => issueSignals.set(code, (issueSignals.get(code) || 0) + 1));
    (history.partsUsed || []).map(normalize).filter(Boolean).forEach((part) => parts.set(part, (parts.get(part) || 0) + 1));
    const completedAt = date(history.serviceDate);
    if (completedAt) {
      const bucket = `${completedAt.getUTCFullYear()}-${String(completedAt.getUTCMonth() + 1).padStart(2, "0")}`;
      trend.set(bucket, (trend.get(bucket) || 0) + 1);
    }
  });
  return {
    total: histories.length,
    byType: [...byType.entries()].map(([type, count]) => ({ type, label: serviceLabels[type] || type.replaceAll("_", " "), count })).sort((a, b) => b.count - a.count),
    byModel: [...byModel.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
    issues: [...issueSignals.entries()].map(([code, count]) => ({ code, issue: signalLabels[code] || code.replaceAll("_", " "), count })).sort((a, b) => b.count - a.count),
    parts: [...parts.entries()].map(([part, count]) => ({ part, count })).sort((a, b) => b.count - a.count || a.part.localeCompare(b.part)),
    trend: [...trend.entries()].map(([bucket, count]) => ({ bucket, count })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
};

function buildBusinessIntelligence({ orders = [], products = [], histories = [], units = [], branches = [], from, to, previousFrom, previousTo } = {}) {
  const currentSales = salesBreakdown(orders, products, { from, to });
  const previousSales = salesBreakdown(orders, products, { from: previousFrom, to: previousTo });
  const currentHistories = histories.filter((item) => {
    const serviceDate = date(item.serviceDate);
    return serviceDate && serviceDate >= from && serviceDate <= to && serviceTypeFor(item) !== "installation";
  });
  const service = serviceBreakdown(currentHistories, units);
  const inventory = summarizeInventoryProducts(products, branches);
  const unitsSoldBySku = new Map(currentSales.models.map((item) => [normalize(item.sku), item.unitsSold]));
  const inventoryMovement = inventory.rows.map((row) => ({
    ...row,
    unitsSoldInPeriod: unitsSoldBySku.get(normalize(row.sku)) || 0,
  })).sort((a, b) => b.unitsSoldInPeriod - a.unitsSoldInPeriod || a.product.localeCompare(b.product));
  const today = new Date();
  const inThirtyDays = new Date(today.getTime() + 30 * 86400000);
  const amp = units.reduce((summary, unit) => {
    const due = date(unit.amp?.bestServicedBy || unit.amp?.nextIdealServiceDate);
    if (!due) summary.unplanned += 1;
    else if (due < today) summary.overdue += 1;
    else if (due <= inThirtyDays) summary.dueWithin30Days += 1;
    const severity = normalize(unit.amp?.visitFollowUp?.severity);
    if (["soon", "urgent", "critical"].includes(severity)) summary.conditionFollowUps += 1;
    return summary;
  }, { unitCount: units.length, overdue: 0, dueWithin30Days: 0, conditionFollowUps: 0, unplanned: 0 });

  const facts = {};
  const totalUnits = currentSales.summary.unitsSold;
  const topModel = currentSales.models[0];
  const topBrand = currentSales.brands[0];
  const currentCollected = currentSales.summary.amountCollected;
  const previousCollected = previousSales.summary.amountCollected;
  addFact(facts, "sales", "sales_total", `${currentSales.summary.transactionCount} paid transaction(s) collected PHP ${currentCollected.toLocaleString("en-PH", { minimumFractionDigits: 2 })} in the selected period.`, "Use the transaction register to verify the orders behind this total.", currentCollected);
  if (topModel) addFact(facts, "sales", "sales_top_model", `${topModel.brand} ${topModel.model} is the highest-volume recorded model with ${topModel.unitsSold} unit(s), representing ${percent(topModel.unitsSold, totalUnits)}% of sold units in the selected period.`, "Use this recorded demand when reviewing replenishment and promotions.", topModel.unitsSold + 1000);
  if (topBrand) addFact(facts, "sales", "sales_top_brand", `${topBrand.brand} is the highest-volume recorded brand with ${topBrand.unitsSold} unit(s) sold.`, "Compare branch stock for this brand with current demand.", topBrand.unitsSold + 500);
  if (previousCollected > 0) {
    const change = round(((currentCollected - previousCollected) / previousCollected) * 100);
    addFact(facts, "sales", "sales_period_change", `Collected sales ${change >= 0 ? "increased" : "decreased"} by ${Math.abs(change)}% compared with the immediately preceding period of equal length.`, change < 0 ? "Review product-level demand and transaction filters before deciding on corrective action." : "Check whether stock can support the observed demand.", Math.abs(change) + 750);
  } else addFact(facts, "sales", "sales_no_comparison", "The immediately preceding comparison period has no recorded paid sales, so a percentage change is not reported.", "Use a longer date range if a historical comparison is needed.", 1);
  const noSales = inventoryMovement.filter((row) => row.currentStock > 0 && row.unitsSoldInPeriod === 0);
  if (noSales.length) addFact(facts, "sales", "sales_slow_moving", `${noSales.length} stocked product/branch line(s) recorded no paid unit sales in the selected period.`, "Review these lines before replenishing them; a zero-period count does not by itself prove long-term low demand.", noSales.length + 100);

  addFact(facts, "service", "service_total", `${service.total} completed non-installation service record(s) fall within the selected period.`, "Review service type and model counts to plan technician capacity.", service.total);
  if (service.byType[0]) addFact(facts, "service", "service_top_type", `${service.byType[0].label} is the most frequently recorded service type with ${service.byType[0].count} completed visit(s).`, "Use this workload when planning technician schedules and cleaning supplies.", service.byType[0].count + 1000);
  if (service.byModel[0]) addFact(facts, "service", "service_top_model", `${service.byModel[0].model} has the highest completed-service count in the period at ${service.byModel[0].count} visit(s).`, "Treat this as service workload, not proof that the model is defective.", service.byModel[0].count + 800);
  const recurringIssue = service.issues.find((item) => item.count >= 2);
  if (recurringIssue) addFact(facts, "service", "service_recurring_issue", `${recurringIssue.issue} appears in ${recurringIssue.count} completed service record(s) in the period.`, "Review the underlying technician records before treating this recorded pattern as a confirmed root cause.", recurringIssue.count + 900);
  else addFact(facts, "service", "service_no_recurring_issue", "The selected period does not contain at least two completed records for the same recognized service concern.", "Continue recording detailed findings so recurring concerns can be identified reliably.", 1);

  addFact(facts, "inventory", "inventory_position", `${inventory.summary.currentStockUnits} unit(s) are currently recorded in stock across ${inventory.summary.productLines} product/branch line(s), with a recorded stock value of PHP ${inventory.summary.inventoryValue.toLocaleString("en-PH", { minimumFractionDigits: 2 })}.`, "Use the branch stock register for the product-level source records.", inventory.summary.inventoryValue);
  if (inventory.summary.outOfStockItems) addFact(facts, "inventory", "inventory_out", `${inventory.summary.outOfStockItems} product/branch line(s) are currently out of stock.`, "Review recent paid demand and approved replenishment records before ordering.", inventory.summary.outOfStockItems + 1000);
  if (inventory.summary.lowStockItems) addFact(facts, "inventory", "inventory_low", `${inventory.summary.lowStockItems} product/branch line(s) are at or below their recorded low-stock threshold.`, "Prioritize lines that also show paid sales or recorded service-parts use.", inventory.summary.lowStockItems + 900);
  const fastMoving = inventoryMovement.find((row) => row.unitsSoldInPeriod > 0);
  if (fastMoving) addFact(facts, "inventory", "inventory_fast_moving", `${fastMoving.product} (${fastMoving.sku}) at ${fastMoving.branch} has the highest recorded paid movement in the period at ${fastMoving.unitsSoldInPeriod} unit(s); current stock is ${fastMoving.currentStock}.`, "Compare remaining stock with the same branch's recent demand before replenishment.", fastMoving.unitsSoldInPeriod + 700);
  const demandPressure = inventoryMovement.find((row) => row.unitsSoldInPeriod > 0 && row.currentStock <= row.unitsSoldInPeriod);
  if (demandPressure) addFact(facts, "inventory", "inventory_demand_pressure", `${demandPressure.product} (${demandPressure.sku}) at ${demandPressure.branch} has ${demandPressure.currentStock} unit(s) in stock after ${demandPressure.unitsSoldInPeriod} recorded paid unit sale(s) in the selected period.`, "Review this possible shortage using pending orders and approved reorder information before replenishment.", demandPressure.unitsSoldInPeriod + 950);
  if (service.parts[0]) addFact(facts, "inventory", "inventory_service_parts", `${service.parts[0].part} is the most frequently recorded service part in completed visits for the period, with ${service.parts[0].count} recorded use(s).`, "Verify the matching catalog/stock item before creating a replenishment request.", service.parts[0].count + 600);

  addFact(facts, "amp", "amp_scope", `${amp.unitCount} active/service-due AC unit(s) are included in the selected branch scope.`, "Generate a unit-level AMP report before scheduling service.", amp.unitCount);
  if (amp.overdue) addFact(facts, "amp", "amp_overdue", `${amp.overdue} AC unit(s) have a recorded suggested servicing date earlier than today.`, "Review each unit's evidence and contact the customer where follow-up is appropriate.", amp.overdue + 1000);
  if (amp.dueWithin30Days) addFact(facts, "amp", "amp_due_soon", `${amp.dueWithin30Days} AC unit(s) have a recorded suggested servicing date within the next 30 days.`, "Use branch workload planning to prepare follow-up capacity.", amp.dueWithin30Days + 900);
  if (amp.conditionFollowUps) addFact(facts, "amp", "amp_condition_follow_up", `${amp.conditionFollowUps} AC unit(s) have an active condition-based follow-up marked soon, urgent, or critical from a completed technician report.`, "Open each unit-level plan and verify the original technician evidence before action.", amp.conditionFollowUps + 1100);
  if (amp.unplanned) addFact(facts, "amp", "amp_missing_schedule", `${amp.unplanned} AC unit(s) do not yet have a recorded suggested servicing date.`, "Review missing installation or cleaning evidence before generating a plan.", amp.unplanned + 500);

  return {
    summary: {
      sales: currentSales.summary,
      service: { completedServices: service.total, regularCleaning: service.byType.find((item) => item.type === "regular_cleaning")?.count || 0, deepCleaning: service.byType.find((item) => item.type === "deep_cleaning")?.count || 0, repairs: service.byType.find((item) => item.type === "repair")?.count || 0, inspections: service.byType.find((item) => item.type === "inspection")?.count || 0 },
      inventory: inventory.summary,
      amp,
    },
    charts: { salesTrend: currentSales.series, serviceTrend: service.trend, serviceByType: service.byType },
    tables: { topModels: currentSales.models.slice(0, 10), topBrands: currentSales.brands.slice(0, 10), servicedModels: service.byModel.slice(0, 10), commonIssues: service.issues.slice(0, 10), serviceParts: service.parts.slice(0, 10), inventoryMovement: inventoryMovement.slice(0, 20), slowMovingInventory: noSales.slice(0, 10) },
    facts,
  };
}

const selectBusinessIntelligenceFacts = (facts = {}, selection = null) => {
  const categories = ["sales", "service", "inventory", "amp"];
  return Object.fromEntries(categories.map((category) => {
    const available = Object.values(facts).filter((fact) => fact.category === category);
    const selectedIds = Array.isArray(selection?.[`${category}_fact_ids`]) ? selection[`${category}_fact_ids`] : [];
    const selected = selectedIds.map((id) => facts[id]).filter((fact) => fact?.category === category);
    const resolved = (selected.length ? selected : available.sort((a, b) => b.weight - a.weight)).slice(0, 3);
    return [category, resolved.map(({ id, statement, action }) => ({ id, statement, action }))];
  }));
};

module.exports = { buildBusinessIntelligence, selectBusinessIntelligenceFacts };
