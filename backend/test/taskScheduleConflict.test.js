const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTimeSlot,
  taskParticipantIds,
  timeSlotsOverlap,
} = require("../src/domain/taskScheduleConflict");

test("schedule slots detect real overlaps without blocking adjacent work", () => {
  assert.deepEqual(parseTimeSlot("9:00 AM – 11:00 AM"), { start: 540, end: 660 });
  assert.equal(timeSlotsOverlap("9:00 AM - 11:00 AM", "10:00 AM - 12:00 PM"), true);
  assert.equal(timeSlotsOverlap("9:00 AM - 11:00 AM", "11:00 AM - 1:00 PM"), false);
  assert.equal(timeSlotsOverlap("TBD", "11:00 AM - 1:00 PM"), false);
});

test("primary technicians and support-team members are all schedule participants", () => {
  assert.deepEqual(taskParticipantIds({
    assignedTechnicianId: "leader",
    schedule: { teamMemberIds: ["support-1", "leader", "support-2"] },
  }), ["leader", "support-1", "support-2"]);
});
