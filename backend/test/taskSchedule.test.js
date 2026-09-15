const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTaskScheduleDetails, normalizeTaskSchedule, serviceCategory } = require("../src/domain/taskSchedule");

test("normalizes optional driver, support team and schedule notes", () => {
  assert.deepEqual(normalizeTaskSchedule({ driverName: "  Driver A  ", notes: "  Bring ladder.  " }, [{ id: "tech-2", name: "Tech Two" }, { id: "tech-2", name: "Tech Two" }]), { driverName: "Driver A", teamMemberIds: ["tech-2"], teamMemberNames: ["Tech Two"], notes: "Bring ladder." });
});
test("builds an installation schedule snapshot from the linked order", () => {
  const details = buildTaskScheduleDetails({ taskCode: "TSK-1", payload: { orderId: "order-1" } }, { order: { orderCode: "ORD-1", paymentMethod: "gcash", paymentStatus: "paid", items: [{ name: "Split AC", quantity: 2 }] } });
  assert.equal(details.category, "installation"); assert.equal(details.reference, "ORD-1"); assert.equal(details.paymentMethod, "GCash"); assert.equal(details.workDescription, "2 × Split AC");
});
test("classifies cleaning and service work without inventing missing fields", () => {
  assert.equal(serviceCategory({ issueType: "Deep Cleaning" }), "deep_cleaning");
  const details = buildTaskScheduleDetails({ taskCode: "TSK-2", issueType: "Check-up", payload: {} });
  assert.equal(details.category, "service_checkup"); assert.equal(details.paymentMethod, ""); assert.equal(details.sellerPersonnel, ""); assert.equal(details.otherExpenses, null);
});
