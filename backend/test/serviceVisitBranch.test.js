const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveServiceVisitBranch } = require("../src/domain/serviceVisitBranch");

test("current service booking branch overrides the original inventory branch", () => {
  const result = resolveServiceVisitBranch({ requestBranch: "Cavite", taskBranch: "Cavite", unitBranch: "Cavite", inventoryBranch: "Bulacan", technicianBranch: "cavite" });
  assert.equal(result.branch, "Cavite");
  assert.equal(result.conflict, "");
  assert.equal(result.technicianMismatch, false);
});

test("a booked branch that conflicts with the AC unit's registered service branch is blocked", () => {
  const result = resolveServiceVisitBranch({ requestBranch: "Cavite", taskBranch: "Cavite", unitBranch: "Bulacan", technicianBranch: "Cavite" });
  assert.match(result.conflict, /registered service branch do not match/i);
});

test("conflicting request and work-order branches remain blocked", () => {
  const result = resolveServiceVisitBranch({ requestBranch: "Cavite", taskBranch: "Laguna", unitBranch: "Cavite", technicianBranch: "Cavite" });
  assert.match(result.conflict, /different branches/i);
});

test("older records fall back to the registered unit branch and reject another technician branch", () => {
  const result = resolveServiceVisitBranch({ unitBranch: "Bulacan", technicianBranch: "Cavite" });
  assert.equal(result.branch, "Bulacan");
  assert.equal(result.technicianMismatch, true);
});
