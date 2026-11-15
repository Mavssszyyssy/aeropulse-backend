const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("sales report restores legacy SKUs and interprets only the authorized filtered totals", async () => {
  const productId = "000000000000000000000101";
  const orders = [{
    _id: "000000000000000000000201",
    orderCode: "ORD-SKU-REPORT",
    customerName: "Customer",
    stockSourceBranch: "Cavite",
    createdAt: "2026-09-10T02:00:00.000Z",
    paymentStatus: "paid",
    workflowStatus: "complete",
    paymentMethod: "gcash",
    paymongo: { paidAt: "2026-09-10T02:05:00.000Z" },
    items: [{ productId, name: "Legacy AC", model: "OLD-VALUE", quantity: 1, price: 20000 }],
    totalAmount: 20000,
  }];
  const originalLoad = Module._load;
  const aiInputs = [];
  let queriedOrders;
  const mocks = {
    "../models/Order": {
      find: (conditions) => {
        queriedOrders = conditions;
        return { lean: async () => orders };
      },
    },
    "../models/Product": {
      find: () => ({
        select() { return this; },
        lean: async () => [{ _id: productId, sku: "CATALOG-SKU-1" }],
      }),
    },
    "../models/AuditLog": {},
    "../services/openAiAmpService": {
      callStructuredAmpAnalysis: async (input) => {
        aiInputs.push(input);
        return { insight: { summary: "Recorded payments appear in this selection.", review_action: "Check the transaction register." } };
      },
    },
  };
  const controllerPath = require.resolve("../src/controllers/reportController");
  delete require.cache[controllerPath];
  Module._load = function load(name, ...args) {
    return mocks[name] || originalLoad.call(this, name, ...args);
  };
  let controller;
  try {
    controller = require(controllerPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[controllerPath];
  }

  const req = {
    authUser: { role: "superadmin" },
    query: { from: "2026-09-01", to: "2026-09-13", status: "paid", branch: "all", sku: "CATALOG-SKU", customer: "Customer" },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.data = value; return this; },
  };
  await controller.getSalesReport(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.transactions[0].sku, "CATALOG-SKU-1");
  assert.equal(res.data.products[0].sku, "CATALOG-SKU-1");
  assert.equal(res.data.sku, "CATALOG-SKU");
  assert.equal(res.data.customer, "Customer");
  assert.equal(res.data.summary.paidRevenue, 20000);
  assert.equal(aiInputs.length, 0);

  req.authUser = { role: "admin", _id: "admin-fixture" };
  req.activeBranch = "Cavite";
  Object.assign(req.query, { branch: "Laguna", interpretation: "1", language: "filipino" });
  await controller.getSalesReport(req, res);
  assert.deepEqual(queriedOrders.$and[1].$or, [
    { stockSourceBranch: "Cavite" },
    { stockSourceBranch: "", customerBranch: "Cavite" },
  ]);
  assert.equal(res.data.branch, "Cavite");
  assert.deepEqual(res.data.interpretation, {
    status: "ready", summary: "Recorded payments appear in this selection.", reviewAction: "Check the transaction register.",
  });
  const { reportInterpretation } = aiInputs[0];
  assert.equal(reportInterpretation.language, "Filipino");
  assert.equal(reportInterpretation.scope.branch, "Cavite");
  assert.equal(reportInterpretation.statistics.paidRevenue, 20000);
  assert.doesNotMatch(JSON.stringify(reportInterpretation), /ORD-SKU-REPORT|Legacy AC|Customer/);

  orders[0].workflowStatus = "cancelled";
  req.query.status = "cancelled";
  await controller.getSalesReport(req, res);
  assert.equal(res.data.summary.transactionCount, 1);
  assert.equal(res.data.summary.amountCollected, 20000);
  assert.equal(res.data.summary.paidRevenue, 0);

  req.query.status = "paid";
  await controller.getSalesReport(req, res);
  assert.equal(res.data.summary.transactionCount, 0);
  assert.deepEqual(res.data.interpretation, { status: "empty" });
  assert.equal(aiInputs.length, 2);
});
