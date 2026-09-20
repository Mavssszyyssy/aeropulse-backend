const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeServiceRequestStatus,
  canTransitionServiceRequest,
  canCustomerCancelServiceRequest,
  resolveServiceAppointmentDate,
} = require("../src/domain/serviceRequestWorkflow");

test("normalizes supported service request statuses and rejects unknown values", () => {
  assert.equal(normalizeServiceRequestStatus("in progress"), "In Progress");
  assert.equal(normalizeServiceRequestStatus("COMPLETED"), "Completed");
  assert.equal(normalizeServiceRequestStatus("made-up"), null);
});

test("customer-selected and confirmed appointment dates are immutable in assignment", () => {
  assert.deepEqual(
    resolveServiceAppointmentDate({ preferredDate: "2099-03-10", requestedDate: "2099-03-10" }),
    { date: "2099-03-10", locked: true, error: "" },
  );
  assert.match(
    resolveServiceAppointmentDate({ preferredDate: "2099-03-10", requestedDate: "2099-03-11" }).error,
    /cannot be changed from the assignment screen/i,
  );
  assert.match(
    resolveServiceAppointmentDate({ preferredDate: "2099-03-10", scheduledDate: "2099-03-15", requestedDate: "2099-03-16" }).error,
    /visit follow-up workflow/i,
  );
  assert.deepEqual(
    resolveServiceAppointmentDate({ requestedDate: "2099-03-12" }),
    { date: "2099-03-12", locked: false, error: "" },
  );
});

test("allows forward workflow transitions and idempotent retries", () => {
  assert.equal(canTransitionServiceRequest("Submitted", "Reviewed"), true);
  assert.equal(canTransitionServiceRequest("Reviewed", "In Progress"), true);
  assert.equal(canTransitionServiceRequest("In Progress", "Completed"), true);
  assert.equal(canTransitionServiceRequest("Assigned", "Assigned"), true);
});

test("prevents reopening terminal service requests", () => {
  assert.equal(canTransitionServiceRequest("Completed", "In Progress"), false);
  assert.equal(canTransitionServiceRequest("Cancelled", "Submitted"), false);
});

test("customers can cancel only before work is active", () => {
  assert.equal(canCustomerCancelServiceRequest("Assigned"), true);
  assert.equal(canCustomerCancelServiceRequest("In Progress"), false);
  assert.equal(canCustomerCancelServiceRequest("Completed"), false);
});

test("service assignment notification follows successful request persistence", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/controllers/serviceRequestController.js"),
    "utf8",
  );
  const updateStart = source.indexOf("const updateServiceRequestStatus = async");
  const updateEnd = source.indexOf("module.exports", updateStart);
  const updateSource = source.slice(updateStart, updateEnd);
  const requestSave = updateSource.indexOf("await request.save();");
  const technicianNotification = updateSource.indexOf(
    'title: scheduleChanged && !technicianChanged ? "Service appointment updated" : "New service task assigned"',
  );

  assert.ok(requestSave >= 0);
  assert.ok(technicianNotification > requestSave);
});
