const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const AuditLog = require("../src/models/AuditLog");
const ContactMessage = require("../src/models/ContactMessage");
const InventoryChangeRequest = require("../src/models/InventoryChangeRequest");
const Order = require("../src/models/Order");
const PartsRequest = require("../src/models/PartsRequest");
const ReorderRequest = require("../src/models/ReorderRequest");
const RestockOrder = require("../src/models/RestockOrder");
const User = require("../src/models/User");
const {
  buildCommerceAnalyticsPipeline,
  getCommerceAnalytics,
  normalizeCommerceAnalytics,
} = require("../src/controllers/dashboardController");
const { createPerformanceTiming } = require("../src/middleware/performanceTiming");
const { forEachWithConcurrency } = require("../src/utils/concurrency");
const { percentile, runReadBenchmark } = require("../scripts/benchmark-read-endpoints");
const { plannedIndexes } = require("../scripts/ensure-performance-indexes");

const hasIndex = (model, expected) => model.schema.indexes().some(([fields]) => (
  JSON.stringify(fields) === JSON.stringify(expected)
));

test("operational list queries have matching compound indexes", () => {
  assert.equal(hasIndex(ReorderRequest, { status: 1, createdAt: -1 }), true);
  assert.equal(hasIndex(PartsRequest, { branch: 1, status: 1, createdAt: -1 }), true);
  assert.equal(hasIndex(InventoryChangeRequest, { requestedBy: 1, createdAt: -1 }), true);
  assert.equal(hasIndex(RestockOrder, { branches: 1, status: 1, createdAt: -1 }), true);
  assert.equal(hasIndex(ContactMessage, { branch: 1, status: 1, createdAt: -1 }), true);
  assert.equal(hasIndex(AuditLog, { createdAt: -1 }), true);
  assert.equal(hasIndex(User, { role: 1, accountStatus: 1, isDeleted: 1, createdAt: -1 }), true);
});

test("bounded concurrency never exceeds its database-safe limit", async () => {
  let active = 0;
  let maximum = 0;
  const completed = [];

  await forEachWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(value);
    active -= 1;
  });

  assert.equal(maximum, 3);
  assert.deepEqual(completed.slice().sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7]);
});

test("commerce dashboard uses one branch-scoped aggregation and keeps its public response shape", () => {
  const pipeline = buildCommerceAnalyticsPipeline("Cavite");
  assert.deepEqual(pipeline[0], {
    $match: {
      $or: [{ customerBranch: "Cavite" }, { stockSourceBranch: "Cavite" }],
    },
  });
  assert.ok(pipeline.some((stage) => stage.$facet));

  const result = normalizeCommerceAnalytics({
    summary: [{ totalOrders: 4, paidOrders: 2, cancelledOrders: 1, revenue: 2500.555 }],
    daily: [{ _id: "2026-10-01", sales: 2500.555, orders: 2 }],
    monthly: [{ _id: "2026-10", sales: 2500.555, orders: 2 }],
    quarterly: [{ _id: { year: 2026, quarter: 4 }, sales: 2500.555, orders: 2 }],
    topProducts: [{ product: "AC", sales: 2500.555, unitsSold: 2 }],
    orderStages: [{ _id: "to_deliver", count: 2, revenue: 2500.555 }],
    paymentMethods: [{ _id: "GCASH", count: 2, revenue: 2500.555 }],
    branches: [{ _id: "Cavite", orders: 4, paidOrders: 2, revenue: 2500.555 }],
  });

  assert.deepEqual(result.summary, {
    totalOrders: 4,
    paidOrders: 2,
    cancelledOrders: 1,
    revenue: 2500.55,
    averageOrderValue: 1250.28,
  });
  assert.deepEqual(result.sales.quarterly[0], { quarter: "2026-Q4", sales: 2500.55, orders: 2 });
  assert.equal(result.orderStages.find((stage) => stage.key === "to_deliver").count, 2);
  assert.equal(result.orderStages.find((stage) => stage.key === "cancelled").count, 0);
});

test("commerce dashboard returns aggregate output without loading order documents", async (t) => {
  let aggregateCalls = 0;
  t.mock.method(Order, "aggregate", async (pipeline) => {
    aggregateCalls += 1;
    assert.ok(pipeline.some((stage) => stage.$facet));
    return [{ summary: [{ totalOrders: 3, paidOrders: 1, cancelledOrders: 0, revenue: 500 }] }];
  });

  const result = await getCommerceAnalytics("Cavite");
  assert.equal(aggregateCalls, 1);
  assert.equal(result.summary.totalOrders, 3);
  assert.equal(result.summary.revenue, 500);
});

test("performance tooling is read-only, reports percentiles, and exposes server timing", () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.ok(plannedIndexes().every((entry) => entry.collection && entry.indexes.length));

  class Response extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
      this.headersSent = false;
      this.statusCode = 200;
    }
    setHeader(name, value) { this.headers[name] = value; }
    end() { this.headersSent = true; this.emit("finish"); }
  }

  const response = new Response();
  createPerformanceTiming({ slowRequestMs: 60000 })(
    { method: "GET", originalUrl: "/api/dashboard?private=value" },
    response,
    () => response.end(),
  );
  assert.match(response.headers["Server-Timing"], /^app;dur=\d+\.\d$/);
});

test("read benchmark records latency and never sends a mutating method", async (t) => {
  t.mock.method(global, "fetch", async (_url, options) => {
    assert.equal(options.method, "GET");
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const result = await runReadBenchmark({
    url: "https://fixture.invalid/api/health",
    requests: 4,
    concurrency: 2,
  });
  assert.equal(result.requests, 4);
  assert.equal(result.failures, 0);
  assert.deepEqual(result.statuses, { 200: 4 });
});
