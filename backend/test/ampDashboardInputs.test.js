const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boundedNumber, branchFilterMatch } = require("../src/domain/ampDashboardService");
const { resolveManagerPipelineScope } = require("../src/controllers/ampController");

test("AMP dashboard query ranges reject abusive or misleading values", () => {
  const options = { fallback: 12, min: 1, max: 24, integer: true, label: "Forecast months" };
  assert.equal(boundedNumber(undefined, options), 12);
  assert.equal(boundedNumber("6", options), 6);
  assert.throws(() => boundedNumber("100000000", options), /1 to 24/);
  assert.throws(() => boundedNumber("-2", options), /1 to 24/);
  assert.throws(() => boundedNumber("1.5", options), /whole number/);
  assert.throws(() => boundedNumber("not-a-number", options), /1 to 24/);
});

test("AMP pipeline pagination has bounded page sizes", () => {
  const pageOptions = { fallback: 1, min: 1, max: 1000000, integer: true, label: "Pipeline page" };
  const sizeOptions = { fallback: 50, min: 10, max: 200, integer: true, label: "Pipeline page size" };
  assert.equal(boundedNumber("2", pageOptions), 2);
  assert.equal(boundedNumber("100", sizeOptions), 100);
  assert.throws(() => boundedNumber("201", sizeOptions), /10 to 200/);
});

test("AMP service pipeline keeps admins branch-scoped and lets Superadmin select an operating branch", () => {
  assert.deepEqual(resolveManagerPipelineScope({
    role: "admin",
    requestedBranch: "Cavite",
    activeBranch: "Bulacan",
  }), { branch: "Bulacan", includeAllBranches: false });

  assert.deepEqual(resolveManagerPipelineScope({
    role: "superadmin",
    requestedBranch: "Cavite",
    activeBranch: "",
  }), { branch: "Cavite", includeAllBranches: true });

  assert.deepEqual(resolveManagerPipelineScope({
    role: "superadmin",
    requestedBranch: "",
    activeBranch: "",
  }), { branch: "", includeAllBranches: true });

  assert.deepEqual(resolveManagerPipelineScope({
    role: "superadmin",
    requestedBranch: "Unassigned",
    activeBranch: "",
  }), { branch: "Unassigned", includeAllBranches: true });

  assert.throws(
    () => resolveManagerPipelineScope({ role: "superadmin", requestedBranch: "Unknown" }),
    /valid operating branch/i,
  );
  assert.throws(
    () => resolveManagerPipelineScope({ role: "admin", activeBranch: "" }),
    /valid branch assignment/i,
  );
});

test("AMP service pipeline explicitly matches units without a branch", () => {
  assert.deepEqual(branchFilterMatch("Bulacan"), { serviceBranch: "Bulacan" });
  assert.deepEqual(branchFilterMatch(""), {});
  assert.deepEqual(branchFilterMatch("Unassigned"), {
    $or: [
      { serviceBranch: { $exists: false } },
      { serviceBranch: null },
      { serviceBranch: "" },
      { serviceBranch: "Unassigned" },
    ],
  });
});

test("AMP dashboards remain read-only instead of recalculating every installed unit", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/domain/ampDashboardService.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /refreshMaintenanceRecommendations/);
});
