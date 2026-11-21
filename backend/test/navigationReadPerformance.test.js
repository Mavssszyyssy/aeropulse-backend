const test = require("node:test");
const assert = require("node:assert/strict");
const Product = require("../src/models/Product");
const ReorderRequest = require("../src/models/ReorderRequest");
const BranchCoverage = require("../src/models/BranchCoverage");
const { listProducts } = require("../src/controllers/productController");
const { listReorders, listMyReorders } = require("../src/controllers/reorderController");
const { clearBranchCoverageCache, getBranchCoverage } = require("../src/services/branchCoverageService");

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const response = () => ({ set() {}, json(body) { return body; } });

test("inventory display skips QR history and repair writes while preserving branch stock", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  let projection;
  let filter;
  t.mock.method(Product, "find", (query) => {
    filter = query;
    return {
      select(fields) { projection = fields; return this; },
      sort: async () => [new Product({ name: "Inverter AC", sku: "INVERTER-1", stock: 7, branchStock: { Bulacan: 2, Cavite: 5 }, price: 20000 })],
    };
  });
  t.mock.method(Product, "bulkWrite", () => assert.fail("Display reads must not repair serials"));
  const result = await listProducts({ authUser: { role: "admin" }, activeBranch: "Bulacan", query: { view: "inventory", branch: "Cavite" } }, response());
  assert.deepEqual(filter, { isActive: { $ne: false } });
  assert.equal(result.products[0].stock, 5);
  assert.deepEqual(result.products[0].branchStock, { Cavite: 5 });
  assert.equal(result.products[0].price, 20000);
  assert.doesNotMatch(projection, /serialUnits|imageData/);
  assert.match(projection, /branchThresholds/);
  await listProducts({ authUser: { role: "superadmin" }, query: { view: "inventory", includeArchived: "true" } }, response());
  assert.deepEqual(filter, {});
});

test("both reorder lists select small product references and retain branch and user scopes", async (t) => {
  const filters = [];
  const projections = [];
  t.mock.method(ReorderRequest, "find", (filter) => {
    filters.push(filter);
    return {
      populate(path, fields) { if (path === "product") projections.push(fields); return this; },
      sort() { return this; }, limit: async () => [],
    };
  });
  const req = { authUser: { role: "admin", _id: "admin-id" }, activeBranch: "Bulacan", query: { status: "submitted" } };
  await listReorders(req, response());
  await listMyReorders(req, response());
  assert.deepEqual(filters, [{ branch: "Bulacan", status: "submitted" }, { branch: "Bulacan", requestedBy: "admin-id" }]);
  for (const fields of projections) {
    assert.match(fields, /branchStock/);
    assert.doesNotMatch(fields, /serialUnits|imageData/);
  }
});

test("concurrent cold branch lookups share one read and invalidation prevents an old refill", async (t) => {
  clearBranchCoverageCache();
  t.after(clearBranchCoverageCache);
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const seed = t.mock.method(BranchCoverage, "bulkWrite", async () => {});
  t.mock.method(BranchCoverage, "find", () => ({
    select() { return this; }, sort() { return this; },
    lean() { reads += 1; return reads === 1 ? first.promise : second.promise; },
  }));
  const a = getBranchCoverage();
  const b = getBranchCoverage();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(seed.mock.callCount(), 1);
  clearBranchCoverageCache();
  const c = getBranchCoverage();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  const current = [{ name: "Cavite", coverageAreas: ["CAVITE"], nearbyBranches: [] }];
  second.resolve(current);
  await c;
  first.resolve([{ name: "Bulacan", coverageAreas: ["bulacan"], nearbyBranches: [] }]);
  assert.deepEqual(await a, await b);
  assert.equal((await getBranchCoverage())[0].name, "Cavite");
  assert.equal(reads, 2);
});
