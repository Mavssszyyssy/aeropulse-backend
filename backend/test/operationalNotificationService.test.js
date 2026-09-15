const test = require("node:test");
const assert = require("node:assert/strict");

const { canReceive } = require("../src/services/operationalNotificationService");
const { canReceivePush, resolveRoute } = require("../src/services/pushNotificationService");

test("in-app operational alerts respect the in-app channel independently of push", () => {
  assert.equal(canReceive({ notifications: { inApp: false, push: true } }, "order"), false);
  assert.equal(canReceive({ notifications: { inApp: true, push: false } }, "order"), true);
});

test("operational alert categories respect their matching preferences", () => {
  assert.equal(canReceive({ notifications: { inApp: true, orderUpdates: false } }, "order"), false);
  assert.equal(canReceive({ notifications: { inApp: true, serviceUpdates: false } }, "technician"), false);
  assert.equal(canReceive({ notifications: { inApp: true, serviceUpdates: false } }, "warranty"), false);
  assert.equal(canReceive({ notifications: { inApp: true, systemAlerts: false } }, "inventory"), false);
});

test("push alerts respect category preferences and valid mobile routes", () => {
  assert.equal(canReceivePush({ notifications: { push: false } }, "order"), false);
  assert.equal(canReceivePush({ notifications: { push: true, serviceUpdates: false } }, "technician"), false);
  assert.equal(canReceivePush({ notifications: { push: true, serviceUpdates: true } }, "technician"), true);
  assert.equal(resolveRoute({ route: "/tech/tasks/TSK-1" }, "technician"), "/technician/tasks");
  assert.equal(
    resolveRoute({ route: "/technician/tasks", targetType: "task", targetId: "TSK-1" }, "technician"),
    "/technician/task/TSK-1/information",
  );
  assert.equal(resolveRoute({ route: "/customer/service-requests" }, "customer"), "/customer/services");
  assert.equal(resolveRoute({ title: "Parts update" }, "technician"), "/technician/tasks");
});
