const test = require("node:test");
const assert = require("node:assert/strict");
const { technicianReportPayload } = require("../src/controllers/taskController");

test("technician task writes retain a bounded client mutation ID for weak-signal reconciliation", () => {
  const result = technicianReportPayload({
    findings: "Restricted airflow recorded.",
    clientMutationId: ` task-${"x".repeat(200)} `,
    assignedTechnicianId: "must-not-be-client-editable",
  });

  assert.equal(result.findings, "Restricted airflow recorded.");
  assert.equal(result.clientMutationId.length, 160);
  assert.equal(result.clientMutationId.startsWith("task-"), true);
  assert.equal(result.assignedTechnicianId, undefined);
});
