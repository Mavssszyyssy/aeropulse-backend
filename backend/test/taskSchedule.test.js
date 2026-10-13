const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTaskScheduleDetails,
  normalizeTaskSchedule,
  serviceCategory,
} = require("../src/domain/taskSchedule");

test("normalizes a single assigned technician schedule and ignores obsolete team input", () => {
  assert.deepEqual(normalizeTaskSchedule(
    { driverName: "  Driver A  ", notes: "  Bring ladder.  ", teamMemberIds: ["legacy-tech"] },
    [{ id: "tech-2", name: "Tech Two" }, { id: "tech-2", name: "Tech Two" }],
  ), {
    driverName: "Driver A",
    notes: "Bring ladder.",
  });
});

test("builds an installation schedule snapshot from the linked order", () => {
  const task = { taskCode: "TSK-1", title: "Fulfill order", payload: { orderId: "order-1" } };
  const details = buildTaskScheduleDetails(task, { order: {
    orderCode: "ORD-1",
    paymentMethod: "gcash",
    paymentStatus: "paid",
    items: [{ name: "Split AC", quantity: 2 }],
  } });
  assert.equal(details.category, "installation");
  assert.equal(details.reference, "ORD-1");
  assert.equal(details.paymentMethod, "GCash");
  assert.equal(details.paymentStatus, "paid");
  assert.equal(details.workDescription, "2 × Split AC");
});

test("classifies cleaning and service work without inventing missing fields", () => {
  assert.equal(serviceCategory({ issueType: "Deep Cleaning" }), "deep_cleaning");
  assert.equal(serviceCategory({ issueType: "Regular Cleaning" }), "regular_cleaning");
  const details = buildTaskScheduleDetails({ taskCode: "TSK-2", issueType: "Check-up", payload: {} });
  assert.equal(details.category, "service_checkup");
  assert.equal(details.paymentMethod, "");
  assert.equal(details.sellerPersonnel, "");
  assert.equal(details.otherExpenses, null);
});
