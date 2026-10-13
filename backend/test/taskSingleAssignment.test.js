const test = require("node:test");
const assert = require("node:assert/strict");
const Task = require("../src/models/Task");

const taskFields = {
  taskCode: "TSK-SINGLE-ASSIGNMENT",
  title: "Assigned work order",
  customer: "Test customer",
  address: "Test address",
  scheduledDate: "2026-10-13",
  timeSlot: "8:00 AM - 10:00 AM",
};

test("new and active work-order persistence requires exactly one assigned technician id", async () => {
  await assert.rejects(
    new Task(taskFields).validate(),
    /assignedTechnicianId.*required/i,
  );

  await assert.doesNotReject(
    new Task({ ...taskFields, assignedTechnicianId: "technician-1" }).validate(),
  );

  const historicalTerminalTask = new Task({ ...taskFields, status: "completed" });
  historicalTerminalTask.isNew = false;
  await assert.doesNotReject(historicalTerminalTask.validate());
});
