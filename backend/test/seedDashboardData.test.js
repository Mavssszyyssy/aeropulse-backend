const test = require("node:test");
const assert = require("node:assert/strict");

const { assignTechnicianToTaskSeeds } = require("../src/seed/seedDashboardData");

test("every seeded work order is assigned to exactly one technician", () => {
  const tasks = assignTechnicianToTaskSeeds({ _id: "technician-1", name: "Technician User" });

  assert.ok(tasks.length > 0);
  tasks.forEach((task) => {
    assert.equal(task.assignedTechnicianId, "technician-1");
    assert.equal(task.assignedTechnicianName, "Technician User");
    assert.equal(task.schedule?.teamMemberIds, undefined);
    assert.equal(task.schedule?.teamMemberNames, undefined);
  });
});

test("dashboard task seeding stops if the canonical technician is missing", () => {
  assert.throws(
    () => assignTechnicianToTaskSeeds(null),
    /requires the canonical demo technician/i,
  );
});
