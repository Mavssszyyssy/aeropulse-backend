const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("sales report endpoint restores the catalog SKU for legacy order items", async () => {
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
  const mocks = {
    "../models/Order": {
      find: () => ({ lean: async () => orders }),
    },
    "../models/Product": {
      find: () => ({
        select() { return this; },
        lean: async () => [{ _id: productId, sku: "CATALOG-SKU-1" }],
      }),
    },
    "../models/AuditLog": {},
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
    query: { from: "2026-09-01", to: "2026-09-13", status: "paid", branch: "all" },
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
});
