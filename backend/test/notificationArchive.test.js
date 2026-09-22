const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const loadController = ({ items = null, anyStored = true } = {}) => {
  const findQueries = [];
  const updates = [];
  const item = {
    _id: "notification-1",
    type: "order",
    unread: true,
    title: "Order update",
    message: "Your order changed.",
    createdAt: new Date("2026-09-11T01:00:00.000Z"),
    toJSON() { return { ...this, id: this._id }; },
  };
  const user = { role: "admin", notifications: {}, lastLogin: new Date() };
  const visibleItems = items === null ? [item] : items;
  const original = Module._load;
  const mocks = {
    "../models/Notification": {
      find: (query) => {
        findQueries.push(query);
        return {
          select() { return this; },
          sort() { return this; },
          limit() { return this; },
          lean: async () => visibleItems,
        };
      },
      exists: async () => anyStored,
      insertMany: async (created) => created,
      findOneAndUpdate: async (query, update) => {
        updates.push({ query, update });
        return item;
      },
    },
    "../models/User": {
      findById: () => ({ select() { return this; }, lean: async () => user }),
    },
  };
  const path = require.resolve("../src/controllers/notificationController");
  delete require.cache[path];
  Module._load = function load(name, ...rest) {
    return mocks[name] || original.call(this, name, ...rest);
  };
  let controller;
  try { controller = require(path); } finally { Module._load = original; delete require.cache[path]; }
  return { controller, findQueries, updates };
};

const response = () => ({
  statusCode: 200,
  set() {},
  status(code) { this.statusCode = code; return this; },
  json(value) { this.data = value; return this; },
});

test("notification folders request active and archived records separately", async () => {
  const fixture = loadController();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: {} }, response());
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: { view: "archived" } }, response());
  assert.deepEqual(fixture.findQueries[0], {
    user: "user-1",
    $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }],
  });
  assert.deepEqual(fixture.findQueries[1], { user: "user-1", archivedAt: { $ne: null } });
});

test("archive and restore are scoped to the signed-in user", async () => {
  const fixture = loadController();
  const req = { authUser: { _id: "user-1" }, params: { id: "notification-1" } };
  await fixture.controller.archiveNotification(req, response());
  await fixture.controller.restoreNotification(req, response());
  assert.deepEqual(fixture.updates[0].query, { _id: "notification-1", user: "user-1" });
  assert.equal(fixture.updates[0].update.$set.unread, false);
  assert.equal(fixture.updates[0].update.$set.status, "read");
  assert.ok(fixture.updates[0].update.$set.archivedAt instanceof Date);
  assert.deepEqual(fixture.updates[1], {
    query: { _id: "notification-1", user: "user-1" },
    update: { $set: { archivedAt: null } },
  });
});

test("archiving every notification does not recreate welcome notices", async () => {
  const fixture = loadController({ items: [], anyStored: true });
  const res = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: {} }, res);
  assert.deepEqual(res.data.notifications, []);
});

test("technicians do not receive obsolete unassigned-order alerts", () => {
  const fixture = loadController();
  const items = [
    { title: "Work order awaiting assignment", dedupeKey: "unassigned-order-task:ORD-1:TECH-1" },
    { title: "Work order assigned to you", dedupeKey: "task-assignment:TSK-1:TECH-1" },
  ];
  assert.deepEqual(
    fixture.controller.applyRoleRelevance(items, "technician"),
    [items[1]],
  );
  assert.deepEqual(fixture.controller.applyRoleRelevance(items, "admin"), items);
});
