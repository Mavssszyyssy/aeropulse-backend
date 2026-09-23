const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const queryResult = (value) => ({
  select() { return this; },
  sort() { return this; },
  limit() { return this; },
  lean: async () => value,
});

const loadService = ({ tasks = [], orders = [], counts = {} } = {}) => {
  const created = [];
  const original = Module._load;
  const emptyModel = { countDocuments: async () => 0 };
  const mocks = {
    "../models/User": { find: () => queryResult([]) },
    "../models/Order": {
      find: () => queryResult(orders),
      countDocuments: async () => counts.orders || 0,
    },
    "../models/ServiceRequest": { countDocuments: async () => counts.services || 0 },
    "../models/Task": {
      find: () => queryResult(tasks),
      countDocuments: async () => counts.tasks || 0,
    },
    "../models/ReorderRequest": { countDocuments: async () => counts.reorders || 0 },
    "../models/ContactMessage": { countDocuments: async () => counts.messages || 0 },
    "./operationalNotificationService": {
      createDedupedNotification: async (payload, options) => {
        created.push({ payload, options });
        return payload;
      },
    },
  };
  const servicePath = require.resolve("../src/services/requiredActionReminderService");
  delete require.cache[servicePath];
  Module._load = function load(name, ...rest) {
    return mocks[name] || emptyModel[name] || original.call(this, name, ...rest);
  };
  let service;
  try { service = require(servicePath); } finally { Module._load = original; delete require.cache[servicePath]; }
  return { service, created };
};

test("technicians receive a deduplicated reminder for an unfinished due work order", async () => {
  const fixture = loadService({ tasks: [{ _id: "task-1", taskCode: "TSK-1", status: "arrived" }] });
  await fixture.service.reconcileRequiredActionsForUser({ _id: "tech-1", role: "technician", notifications: {} }, {
    now: new Date("2026-09-24T08:00:00.000Z"), force: true,
  });
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0].payload.targetType, "task");
  assert.match(fixture.created[0].payload.message, /service notes, unit verification, and proof/);
  assert.equal(fixture.created[0].options.dedupeMinutes, 720);
});

test("staff reminders are role and branch scoped summaries", async () => {
  const fixture = loadService({ counts: { services: 2, tasks: 1, messages: 3, orders: 1 } });
  await fixture.service.reconcileRequiredActionsForUser({
    _id: "admin-1", role: "admin", activeBranch: "Cavite", notifications: {},
  }, { force: true });
  assert.deepEqual(fixture.created.map((item) => item.payload.title).sort(), [
    "Action required: activate work orders",
    "Action required: assign service requests",
    "Action required: reply to customers",
    "Action required: review order requests",
  ]);
  assert.ok(fixture.created.every((item) => item.payload.route.startsWith("/admin/")));
});

test("customers are reminded only for server-confirmed unfinished payments", async () => {
  const fixture = loadService({ orders: [{ _id: "order-1", orderCode: "ORD-1", paymentStatus: "failed" }] });
  await fixture.service.reconcileRequiredActionsForUser({ _id: "customer-1", role: "customer", notifications: {} }, { force: true });
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.created[0].payload.type, "payment");
  assert.equal(fixture.created[0].payload.targetId, "order-1");
});
