const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assignTechnicianToTaskSeeds,
  findCanonicalDemoTechnician,
} = require("../src/seed/seedDashboardData");

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

test("dashboard task seeding finds the canonical technician after their contact email changes", async () => {
  const technician = {
    _id: "technician-1",
    alias: "tech.main",
    email: "updated-technician@example.com",
    role: "technician",
  };
  let query;
  const found = await findCanonicalDemoTechnician({
    findOne: async (value) => {
      query = value;
      return technician;
    },
  });

  assert.equal(found, technician);
  assert.deepEqual(query, {
    role: "technician",
    $or: [{ alias: "tech.main" }, { username: "tech.main" }],
  });
});
