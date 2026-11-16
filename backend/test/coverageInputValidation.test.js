const test = require("node:test");
const assert = require("node:assert/strict");
const { createBranchCoverage, normalizeCoverageAreas } = require("../src/controllers/branchCoverageController");
const { validateBranchName } = require("../src/domain/branchInputValidation");

test("comma-delimited service areas trim and normalize while ambiguous or duplicate inputs fail", () => {
  assert.deepEqual(normalizeCoverageAreas(" Quezon City , Malolos "), { coverageAreas: ["quezon city", "malolos"] });
  assert.match(normalizeCoverageAreas("Manila Quezon City").error, /separate them with commas/i);
  assert.match(normalizeCoverageAreas("Malolos, malolos").error, /duplicate/i);
  assert.match(normalizeCoverageAreas("Cavite,").error, /empty/i);
  assert.match(normalizeCoverageAreas(" ").error, /empty/i);
});

test("branch inputs reject repeated filler while preserving accented names and numbered areas", () => {
  assert.match(validateBranchName("Qaaaaaaaaaa").error, /repeated characters/i);
  assert.match(validateBranchName(12345).error, /valid branch name/i);
  assert.match(validateBranchName("....").error, /valid branch name/i);
  assert.deepEqual(validateBranchName("  Biñan   North  "), { name: "Biñan North" });
  assert.match(normalizeCoverageAreas("Cavite, sssssssssssss").error, /repeated characters/i);
  assert.match(normalizeCoverageAreas("Cavite, ...").error, /valid location/i);
  assert.deepEqual(normalizeCoverageAreas("Sto. Niño, District 2"), { coverageAreas: ["sto. niño", "district 2"] });
});

test("the create endpoint rejects invalid branch input before database work", async () => {
  for (const body of [
    { name: "Qaaaaaaaaaa", coverageAreas: "Malolos" },
    { name: "Pampanga", coverageAreas: "Sssssssssssssss" },
  ]) {
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(data) { this.data = data; return this; },
    };
    await createBranchCoverage({ body }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.data.message, /repeated characters/i);
  }
});
