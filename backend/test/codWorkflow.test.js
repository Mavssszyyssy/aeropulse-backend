const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const cod = require("../src/utils/codPayment");
const source = fs.readFileSync(require.resolve("../src/controllers/orderController"), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const actions = vm.runInNewContext(extract("const lifecycleActions =", "const restoreStockForCancelledOrder") + "; lifecycleActions");
const noop = async () => {};
const buildAction = (state) => vm.runInNewContext(extract("const applyOrderLifecycleAction =", "const approveOrder") + "; applyOrderLifecycleAction", {
  ...cod, lifecycleActions: actions, HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  workflowLabel: s => s, findLinkedTaskForOrder: async () => null,
  resolveTechnicianAssignment: async options => ({ assignedTechnicianId: options.assignedTechnicianId || "", assignedTechnicianName: "Tech" }),
  reReserveReleasedOrderInventory: async order => { state.reservations++; order.stockReservationStatus = "reserved"; },
  appendFulfillmentEvent: (o, stage) => state.events.push(stage), updateSerialUnitsForOrder: noop,
  createTaskForOrder: async (o, opts) => { state.activated = opts.activate; },
  createOrderNotification: noop, createStaffOrderNotification: noop,
});
test("legacy pending COD dispatch reserves once and does not record arrival or payment", async () => {
  const state = { reservations: 0, events: [] };
  const apply = buildAction(state);
  const order = { orderCode: "COD-1", workflowStatus: "to_pay", paymentMethod: "cod", paymentStatus: "pending", status: "pending", stockReservationStatus: "pending", save: noop };
  await assert.rejects(apply(order, "approve"), /do not require payment approval/);
  await assert.rejects(apply(order, "dispatch"), /Assign a technician/);
  await apply(order, "dispatch", { assignedTechnicianId: "tech" });
  assert.equal(order.workflowStatus, "to_dispatch");
  assert.equal(order.deliveryStatus, "dispatched");
  assert.equal(order.status, "pending");
  assert.equal(order.paymentStatus, "pending");
  assert.equal(state.reservations, 1);
  assert.equal(state.activated, true);
  assert.deepEqual(state.events, ["dispatched"]);
  await assert.rejects(apply(order, "dispatch"), /already dispatched/);
  assert.equal(state.reservations, 1);
  await assert.rejects(apply(order, "complete"), /Cannot complete/);
});
test("new checkout-reserved COD dispatch does not reserve stock again", async () => {
  const state = { reservations: 0, events: [] };
  const apply = buildAction(state);
  const order = { orderCode: "COD-2", workflowStatus: "to_deliver", paymentMethod: "cod", paymentStatus: "pending", status: "pending", stockReservationStatus: "reserved", save: noop };
  await apply(order, "dispatch", { assignedTechnicianId: "tech" });
  assert.equal(order.workflowStatus, "to_dispatch");
  assert.equal(state.reservations, 0);
  assert.equal(state.activated, true);
});
test("cash collection requires COD, dispatch, assigned technician and check-in", () => {
  const order = { paymentMethod: "cod", workflowStatus: "to_install", dispatchedAt: new Date(), assignedTechnicianId: "tech" };
  const task = { status: "in-progress", assignedTechnicianId: "tech", payload: { checkIn: { checkedInAt: new Date() } } };
  assert.equal(cod.codCollectionBlocker(order, task, "tech"), null);
  assert.match(cod.codCollectionBlocker(order, task, "other"), /assigned technician/);
  assert.match(cod.codCollectionBlocker({ ...order, workflowStatus: "to_pay" }, task, "tech"), /dispatched/);
  assert.match(cod.codCollectionBlocker(order, { ...task, payload: {} }, "tech"), /Check in/);
  assert.match(cod.codCollectionBlocker({ ...order, paymentMethod: "gcash" }, task, "tech"), /does not have/);
  assert.equal(cod.hasCodCollection({ workflowStatus: "complete", status: "paid" }), false);
});
