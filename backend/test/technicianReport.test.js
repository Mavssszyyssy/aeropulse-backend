const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { activeTechnicianQuery } = require("../src/controllers/dashboardController");

test("technician reports include only active, non-deleted technician accounts", () => {
  assert.deepEqual(activeTechnicianQuery("Cavite"), {
    role: "technician",
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
    $or: [{ assignedBranch: "Cavite" }, { assignedBranch: "" }],
  });
});

test("technician report applies the selected date and branch to completed work", async () => {
  let taskQuery;
  let selectedFields;
  const originalLoad = Module._load;
  const mocks = {
    "../models/User": {
      find: () => ({
        select() { return this; },
        sort() { return this; },
        lean: async () => [{ _id: "tech-1", name: "Cavite Technician", assignedBranch: "Cavite" }],
      }),
    },
    "../models/Task": {
      find: (query) => {
        taskQuery = query;
        return { select(fields) { selectedFields = fields; return this; }, lean: async () => [{
          assignedTechnicianId: "tech-1", assignedAt: "2026-09-10T05:00:00Z",
          completedAt: "2026-09-10T07:00:00Z", scheduledDate: "2026-09-10", timeSlot: "1:00 PM - 3:00 PM",
        }] };
      },
    },
    "../models/Order": {},
    "../models/Product": {},
    "../models/AuditLog": {},
  };
  const controllerPath = require.resolve("../src/controllers/reportController");
  delete require.cache[controllerPath];
  Module._load = function load(name, ...args) {
    return mocks[name] || originalLoad.call(this, name, ...args);
  };
  let controller;
  try {
    controller = require(controllerPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[controllerPath];
  }
  const req = {
    authUser: { role: "admin" }, activeBranch: "Cavite",
    query: { from: "2026-09-01", to: "2026-09-10", search: "Cavite" },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.data = value; return this; },
  };
  await controller.getTechnicianReport(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(taskQuery.branch, "Cavite");
  assert.equal(taskQuery.completedAt.$gte.toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(taskQuery.completedAt.$lte.toISOString(), "2026-09-10T15:59:59.999Z");
  assert.deepEqual(res.data.summary, { technicianCount: 1, completedInPeriod: 1 });
  for (const field of ["assignedAt", "completedAt", "scheduledDate", "timeSlot"]) assert.ok(selectedFields.split(" ").includes(field));
  assert.equal(res.data.rows[0].averageCompletionHours, 2);
  assert.equal(res.data.rows[0].onTimeRate, 100);
});
