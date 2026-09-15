const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTechnicianPerformanceReport,
  filterInventoryRows,
  filterSalesOrders,
  normalizePaymentMethodFilter,
  normalizedOrderTotals,
  resolveReportRange,
  summarizeInventoryProducts,
  summarizeSalesOrders,
} = require("../src/domain/operationalReports");

test("sales report filters by payment method and order, customer, or SKU text", () => {
  const orders = [
    { orderCode: "ORD-GCASH", customerName: "Ana Cruz", paymentMethod: "gcash", items: [{ sku: "AC-G-1", name: "Split AC" }] },
    { orderCode: "ORD-CARD", customerName: "Ben Reyes", paymentMethod: "credit_card", items: [{ sku: "AC-C-2", name: "Window AC" }] },
  ];
  assert.deepEqual(filterSalesOrders(orders, { paymentMethod: "gcash" }).map((order) => order.orderCode), ["ORD-GCASH"]);
  assert.deepEqual(filterSalesOrders(orders, { paymentMethod: "card", search: "AC-C-2" }).map((order) => order.orderCode), ["ORD-CARD"]);
  assert.deepEqual(filterSalesOrders(orders, { search: "ana" }).map((order) => order.orderCode), ["ORD-GCASH"]);
  assert.deepEqual(filterSalesOrders(orders, { sku: "AC-C", customer: "Ben" }).map((order) => order.orderCode), ["ORD-CARD"]);
  assert.throws(() => normalizePaymentMethodFilter("bank-transfer"), /unsupported payment method/i);
});

test("inventory report filters by category and brand", () => {
  const rows = [
    { category: "Split", brand: "Daikin", sku: "D-1" },
    { category: "Window", brand: "TCL", sku: "T-1" },
    { category: "Split", brand: "LG Premium", sku: "L-1" },
  ];
  assert.deepEqual(filterInventoryRows(rows, { category: "split", brand: "lg" }).map((row) => row.sku), ["L-1"]);
  assert.deepEqual(filterInventoryRows(rows, { category: "window" }).map((row) => row.sku), ["T-1"]);
  assert.deepEqual(filterInventoryRows(rows, { brand: "daikin", sku: "D-1" }).map((row) => row.sku), ["D-1"]);
});

test("technician report counts completed work in the selected dataset and supports search", () => {
  const technicians = [
    { _id: "t1", name: "Alex Tech", activeBranch: "Cavite" },
    { _id: "t2", name_first: "Bea", name_last: "Santos", assignedBranch: "Laguna" },
  ];
  const completedTasks = [
    { assignedTechnicianId: "t1" }, { assignedTechnicianId: "t1" }, { assignedTechnicianId: "t2" },
  ];
  const report = buildTechnicianPerformanceReport(technicians, completedTasks, { search: "cavite" });
  assert.deepEqual(report.summary, { technicianCount: 1, completedInPeriod: 2 });
  assert.deepEqual(report.rows, [{ technician: "Alex Tech", branch: "Cavite", completedWorkOrders: 2 }]);
});

test("report range includes the complete selected end date and rejects a reversed range", () => {
  const range = resolveReportRange({ from: "2026-09-01", to: "2026-09-10" });
  assert.equal(range.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-09-10T23:59:59.999Z");
  assert.throws(() => resolveReportRange({ from: "2026-09-11", to: "2026-09-10" }), /start date must be on or before/i);
});

test("sales totals use stored order charges and only confirmed non-cancelled paid transactions", () => {
  const orders = [
    {
      orderCode: "ORD-PAID", customerName: "Customer", stockSourceBranch: "Cavite",
      createdAt: "2026-08-30T01:00:00.000Z", paymentStatus: "paid", workflowStatus: "to_deliver", paymentMethod: "gcash",
      paymongo: { paidAt: "2026-09-10T15:00:00.000Z" },
      items: [{ productId: "p1", name: "AC One", model: "M1", quantity: 2, price: 1000 }],
      subtotalAmount: 2000, vatAmount: 240, shippingFee: 350, discountAmount: 100, totalAmount: 2490,
      receipt: { amountPaid: 2490 },
    },
    {
      orderCode: "ORD-UNPAID", createdAt: "2026-09-10T10:00:00.000Z", paymentStatus: "pending", workflowStatus: "to_pay",
      items: [{ productId: "p1", name: "AC One", quantity: 1, price: 1000 }], totalAmount: 1590,
    },
    {
      orderCode: "ORD-CANCELLED-PAID", createdAt: "2026-09-09T10:00:00.000Z", paymentStatus: "paid", workflowStatus: "cancelled",
      paymongo: { paidAt: "2026-09-09T10:05:00.000Z" },
      items: [{ productId: "p2", name: "AC Two", quantity: 1, price: 500 }], totalAmount: 500,
    },
  ];
  const report = summarizeSalesOrders(orders, {
    status: "paid", interval: "daily",
    from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-10T23:59:59.999Z"),
  });
  assert.deepEqual(report.summary, {
    transactionCount: 1, unitsSold: 2, merchandiseSubtotal: 2000, vatAmount: 240,
    deliveryFees: 350, discounts: 100, totalOrderValue: 2490, amountCollected: 2490,
  });
  assert.equal(report.transactions[0].transactionDate, "2026-09-10T15:00:00.000Z");
  assert.equal(report.transactions[0].sku, "M1");
  assert.equal(report.products[0].sku, "M1");
  assert.equal(report.products[0].merchandiseSales, 2000);
});

test("sales report prefers the persisted catalog SKU over legacy model data", () => {
  const report = summarizeSalesOrders([{
    orderCode: "ORD-SKU", customerName: "Customer", stockSourceBranch: "Cavite",
    createdAt: "2026-09-10T10:00:00.000Z", paymentStatus: "paid", workflowStatus: "complete",
    items: [{ productId: "p1", sku: "SKU-ACTUAL", model: "SKU-LEGACY", name: "AC One", quantity: 1, price: 1000 }],
    totalAmount: 1000,
  }], { status: "paid" });
  assert.equal(report.transactions[0].sku, "SKU-ACTUAL");
  assert.equal(report.products[0].sku, "SKU-ACTUAL");
});

test("legacy totals fall back to item lines without inventing charges", () => {
  assert.deepEqual(normalizedOrderTotals({ paymentStatus: "paid", items: [{ quantity: 3, price: 125.5 }] }), {
    subtotal: 376.5, vat: 0, deliveryFee: 0, discount: 0, total: 376.5, amountCollected: 376.5,
  });
});

test("inventory report keeps useful branch stock data and omits operational lifecycle fields", () => {
  const report = summarizeInventoryProducts([{
    name: "AC One", sku: "AC-1", brand: "Cold Air", category: "Split", specs: "1 HP", price: 20000, threshold: 2,
    branchStock: new Map([["Cavite", 3]]),
    serialUnits: [{ branch: "Cavite", status: "available" }, { branch: "Cavite", status: "available" }, { branch: "Cavite", status: "assigned" }],
  }], ["Cavite"]);
  assert.equal(report.rows[0].currentStock, 3);
  assert.equal(report.rows[0].availableSerials, 2);
  assert.equal(report.rows[0].stockValue, 60000);
  for (const field of ["assignedUnits", "serviceUnits", "retiredUnits", "trackedUnits", "inventoryVariance", "reorderLevel"]) {
    assert.equal(Object.hasOwn(report.rows[0], field), false);
  }
  assert.equal(Object.hasOwn(report.summary, "inventoryVarianceItems"), false);
});
