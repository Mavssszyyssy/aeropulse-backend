const test = require("node:test");
const assert = require("node:assert/strict");
const { activeTechnicianQuery } = require("../src/controllers/dashboardController");

test("technician reports include only active, non-deleted technician accounts", () => {
  assert.deepEqual(activeTechnicianQuery("Cavite"), {
    role: "technician",
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
    $or: [{ assignedBranch: "Cavite" }, { assignedBranch: "" }],
  });
});
