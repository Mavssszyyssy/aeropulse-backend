const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBusinessIntelligence, selectBusinessIntelligenceFacts } = require("../src/domain/businessIntelligence");

const from = new Date("2026-09-01T00:00:00.000Z");
const to = new Date("2026-09-30T23:59:59.999Z");
const previousFrom = new Date("2026-08-01T00:00:00.000Z");
const previousTo = new Date("2026-08-31T23:59:59.999Z");

test("business intelligence derives sales, service, inventory, and AMP facts only from records", () => {
  const products = [{ _id: "p1", name: "Dual Inverter", sku: "LG-1", brand: "LG", specs: "1 HP", category: "split", price: 20000, branchStock: { Cavite: 2 }, branchThresholds: { Cavite: 2 }, serialUnits: [] }];
  const orders = [{ _id: "o1", orderCode: "ORD-1", createdAt: "2026-09-10", paymentStatus: "paid", workflowStatus: "complete", totalAmount: 40000, receipt: { amountPaid: 40000, issuedAt: "2026-09-10" }, items: [{ productId: "p1", name: "Dual Inverter", quantity: 2, price: 20000 }] }];
  const units = [{ _id: "u1", brand: "LG", modelName: "Dual Inverter", status: "service_due", amp: { bestServicedBy: "2026-08-20", visitFollowUp: { severity: "soon" } } }];
  const histories = [
    { unit: "u1", serviceDate: "2026-09-12", serviceType: "regular_cleaning", findings: "Dirty air filter", partsUsed: ["Air filter"] },
    { unit: "u1", serviceDate: "2026-09-20", serviceType: "deep_cleaning", findings: "Air filter was clogged", partsUsed: ["Air filter"] },
  ];
  const result = buildBusinessIntelligence({ orders, products, histories, units, branches: ["Cavite"], from, to, previousFrom, previousTo });
  assert.equal(result.summary.sales.unitsSold, 2);
  assert.equal(result.summary.service.completedServices, 2);
  assert.equal(result.summary.inventory.currentStockUnits, 2);
  assert.equal(result.summary.amp.overdue, 1);
  assert.equal(result.summary.amp.conditionFollowUps, 1);
  assert.match(result.facts.sales_top_model.statement, /100%/);
  assert.match(result.facts.service_recurring_issue.statement, /2 completed service record/);
  assert.equal(result.tables.serviceParts[0].part, "air filter");
  assert.deepEqual(result.charts.serviceTrend, [{ bucket: "2026-09", count: 2 }]);
  const selected = selectBusinessIntelligenceFacts(result.facts);
  assert.ok(selected.sales.length);
  assert.ok(selected.service.length);
  assert.ok(selected.inventory.length);
  assert.ok(selected.amp.length);
});

test("business intelligence does not claim a recurring issue from one record", () => {
  const result = buildBusinessIntelligence({
    orders: [], products: [], units: [], branches: ["Cavite"], from, to, previousFrom, previousTo,
    histories: [{ unit: "u1", serviceDate: "2026-09-12", serviceType: "inspection", findings: "Customer mentioned unusual vibration" }],
  });
  assert.equal(result.facts.service_recurring_issue, undefined);
  assert.match(result.facts.service_no_recurring_issue.statement, /does not contain at least two/);
});
