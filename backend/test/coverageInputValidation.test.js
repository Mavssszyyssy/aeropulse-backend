const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCoverageAreas } = require("../src/controllers/branchCoverageController");

test("comma-delimited service areas trim and normalize while ambiguous or duplicate inputs fail", () => {
  assert.deepEqual(normalizeCoverageAreas(" Quezon City , Malolos "), { coverageAreas: ["quezon city", "malolos"] });
  assert.match(normalizeCoverageAreas("Manila Quezon City").error, /separate them with commas/i);
  assert.match(normalizeCoverageAreas("Malolos, malolos").error, /duplicate/i);
  assert.match(normalizeCoverageAreas("Cavite,").error, /empty/i);
  assert.match(normalizeCoverageAreas(" ").error, /empty/i);
});
