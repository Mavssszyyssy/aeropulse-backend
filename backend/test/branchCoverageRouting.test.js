const test = require("node:test");
const assert = require("node:assert/strict");
const BranchCoverage = require("../src/models/BranchCoverage");
const { clearBranchCoverageCache, resolveConfiguredBranch } = require("../src/services/branchCoverageService");

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
