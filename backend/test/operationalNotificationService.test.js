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
  assert.equal(resolveRoute({
    route: "/customer/orders",
    type: "order",
    targetType: "order",
    targetId: "order-id",
    message: "Your warranty and active unit record are now available.",
  }, "customer"), "/customer/orders?orderId=order-id");
  assert.equal(resolveRoute({
    route: "/contact",
    targetType: "contact_message",
    targetId: "message-id",
  }, "customer"), "/customer/contact?messageId=message-id");
  assert.equal(resolveRoute({
    targetType: "service_request",
    targetId: "request-id",
  }, "customer"), "/customer/services?requestId=request-id");
  assert.equal(resolveRoute({
    type: "warranty",
    targetType: "warranty",
    targetId: "unit-id",
  }, "customer"), "/customer/units/unit-id?page=warranty");
  assert.equal(resolveRoute({ title: "Parts update" }, "technician"), "/technician/tasks");
});
