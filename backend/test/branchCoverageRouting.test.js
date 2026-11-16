const test = require("node:test");
const assert = require("node:assert/strict");
const BranchCoverage = require("../src/models/BranchCoverage");
const { clearBranchCoverageCache, resolveConfiguredBranch } = require("../src/services/branchCoverageService");
const { listAddresses } = require("../src/controllers/userController");

test("province ownership wins over stale cross-branch coverage; unknown areas stay unsupported", async (t) => {
  t.mock.method(BranchCoverage, "bulkWrite", async () => {});
  t.mock.method(BranchCoverage, "find", () => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => [
      { name: "Cavite", coverageAreas: ["bacoor", "dasmarinas"], nearbyBranches: [], active: true },
      { name: "Laguna", coverageAreas: ["laguna", "cavite", "cabuyao"], nearbyBranches: [], active: true },
    ],
  }));
  clearBranchCoverageCache();
  assert.equal((await resolveConfiguredBranch({ city: "Imus", province: "Cavite" }))?.name, "Cavite");
  assert.equal((await resolveConfiguredBranch({ city: "Cabuyao", province: "Laguna" }))?.name, "Laguna");
  assert.equal(await resolveConfiguredBranch({ city: "Unknown City", province: "Unknown Province" }), null);
  clearBranchCoverageCache();
});

test("shop address reads can resolve the default delivery branch in the same response", async (t) => {
  t.mock.method(BranchCoverage, "bulkWrite", async () => {});
  t.mock.method(BranchCoverage, "find", () => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => [
      { name: "Cavite", coverageAreas: ["bacoor"], nearbyBranches: [], active: true },
      { name: "Laguna", coverageAreas: ["cabuyao"], nearbyBranches: [], active: true },
    ],
  }));
  clearBranchCoverageCache();
  t.after(clearBranchCoverageCache);
  const addresses = [
    { city: "Cabuyao", province: "Laguna" },
    { city: "Bacoor", province: "Cavite", isDefault: true },
  ];
  const res = { json(result) { return result; } };
  assert.deepEqual(await listAddresses({ authUser: { addresses } }, res), { addresses });
  const query = { resolveDeliveryBranch: "true" };
  assert.deepEqual(await listAddresses({ authUser: { addresses }, query }, res), { addresses, deliveryBranch: "Cavite" });
  assert.deepEqual(await listAddresses({ authUser: { addresses: [] }, query }, res), { addresses: [], deliveryBranch: "" });
});
