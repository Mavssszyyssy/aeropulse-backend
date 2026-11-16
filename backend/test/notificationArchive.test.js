const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const loadController = ({ items = null, anyStored = true, role = "admin", archiveDedupeKey } = {}) => {
  const findQueries = [];
  const queryLimits = [];
  const updates = [];
  const item = {
    _id: "notification-1",
    type: "order",
    unread: true,
    dedupeKey: archiveDedupeKey,
    title: "Order update",
    message: "Your order changed.",
    createdAt: new Date("2026-09-11T01:00:00.000Z"),
    toJSON() { return { ...this, id: this._id }; },
  };
  const user = { role, notifications: {}, lastLogin: new Date() };
  const visibleItems = items === null ? [item] : items;
  const original = Module._load;
  const mocks = {
    "../models/Notification": {
      find: (query) => {
        findQueries.push(query);
        let queryLimit;
        return {
          select() { return this; },
          sort() { return this; },
          limit(value) { queryLimit = value; queryLimits.push(value); return this; },
          lean: async () => queryLimit ? visibleItems.slice(0, queryLimit) : visibleItems,
        };
      },
      exists: async () => anyStored,
      insertMany: async (created) => created,
      findOneAndUpdate: async (query, update) => {
        updates.push({ query, update });
        return item;
      },
      findOne: async (query) => {
        findQueries.push(query);
        return item;
      },
      updateMany: async (query, update) => {
        updates.push({ query, update });
        return { modifiedCount: 12 };
      },
    },
    "../models/User": {
      findById: () => ({ select() { return this; }, lean: async () => user }),
    },
    "../services/requiredActionReminderService": {
      reconcileRequiredActionsForUser: async () => [],
    },
  };
  const path = require.resolve("../src/controllers/notificationController");
  delete require.cache[path];
  Module._load = function load(name, ...rest) {
    return mocks[name] || original.call(this, name, ...rest);
  };
  let controller;
  try { controller = require(path); } finally { Module._load = original; delete require.cache[path]; }
  return { controller, findQueries, queryLimits, updates };
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
  assert.deepEqual(fixture.findQueries[0], { _id: "notification-1", user: "user-1" });
  assert.equal(fixture.updates[1].query.user, "user-1");
  assert.deepEqual(fixture.updates[1].query.archivedAt, { $ne: null });
  assert.deepEqual(fixture.updates[1].query.$or[0], { _id: "notification-1" });
  assert.deepEqual(fixture.updates[1].query.$or[1].dedupeKey, { $in: [null, ""] });
  assert.deepEqual(fixture.updates[1].update, { $set: { archivedAt: null } });
});

test("archive all updates all active alerts for the authenticated account in one write", async () => {
  const fixture = loadController();
  const res = response();
  await fixture.controller.archiveAllNotifications({ authUser: { _id: "self" }, body: { user: "other" } }, res);
  assert.equal(fixture.updates.length, 1);
  assert.deepEqual(fixture.updates[0].query, { user: "self", archivedAt: null });
  assert.ok(fixture.updates[0].update.$set.archivedAt instanceof Date);
  assert.equal(fixture.updates[0].update.$set.unread, false);
  assert.equal(fixture.updates[0].update.$set.status, "read");
  assert.deepEqual(res.data, { modifiedCount: 12 });
});

test("archive selected updates only the requested active IDs for the authenticated account", async () => {
  const fixture = loadController();
  const first = "507f1f77bcf86cd799439011";
  const second = "507f1f77bcf86cd799439012";
  const res = response();
  await fixture.controller.archiveSelectedNotifications({
    authUser: { _id: "self" },
    body: { user: "another-account", ids: [first, second, first] },
  }, res);
  assert.equal(fixture.updates.length, 1);
  assert.deepEqual(fixture.updates[0].query, { user: "self", archivedAt: null, _id: { $in: [first, second] } });
  assert.equal(fixture.updates[0].update.$set.unread, false);
  assert.equal(fixture.updates[0].update.$set.status, "read");
  assert.ok(fixture.updates[0].update.$set.archivedAt instanceof Date);
  assert.equal(res.statusCode, 200);
});

test("archive selected validates an entire batch before attempting any write", async () => {
  const fixture = loadController();
  const valid = "507f1f77bcf86cd799439011";
  for (const ids of [undefined, [], valid, [valid, "invalid"], [{ $ne: null }], Array(31).fill(valid)]) {
    const res = response();
    await fixture.controller.archiveSelectedNotifications({ authUser: { _id: "self" }, body: { ids } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(fixture.updates.length, 0);
});

test("archived pages include older alerts and deduplicate before slicing", async () => {
  const items = Array.from({ length: 105 }, (_, index) => ({ _id: `n-${index}`, type: "system", title: `Alert ${index}` }));
  const fixture = loadController({ items: [items[0], ...items] });
  const req = { authUser: { _id: "self" } };
  const first = response();
  await fixture.controller.listMyNotifications({ ...req, query: { view: "archived" } }, first);
  assert.equal(first.data.notifications.length, 30);
  assert.equal(first.data.notifications[29].id, "n-29");
  assert.equal(first.data.hasMore, true);
  const last = response();
  await fixture.controller.listMyNotifications({ ...req, query: { view: "archived", page: "4" } }, last);
  assert.equal(last.data.notifications[0].id, "n-90");
  assert.equal(last.data.notifications.at(-1).id, "n-104");
  assert.equal(last.data.hasMore, false);
});

test("archiving every notification does not recreate welcome notices", async () => {
  const fixture = loadController({ items: [], anyStored: true });
  const res = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: {} }, res);
  assert.deepEqual(res.data.notifications, []);
});

test("technician archive also hides active duplicates owned by that technician", async () => {
  const req = { authUser: { _id: "tech-1", role: "technician" }, params: { id: "notification-1" } };
  const fixture = loadController({ archiveDedupeKey: "assignment-1" });
  await fixture.controller.archiveNotification(req, response());
  assert.deepEqual(fixture.updates[1].query, { user: "tech-1", archivedAt: null, dedupeKey: "assignment-1" });
  assert.deepEqual(fixture.updates[1].update, fixture.updates[0].update);

  const legacy = loadController();
  await legacy.controller.archiveNotification(req, response());
  assert.deepEqual(legacy.updates[1].query, {
    user: "tech-1", archivedAt: null, dedupeKey: { $in: [null, ""] },
    type: "order", targetType: { $in: [null, ""] }, targetId: { $in: [null, ""] },
    title: "Order update", message: "Your order changed.",
  });
});

test("customer alerts expose an id that can be used by the read endpoint", async () => {
  const customerAlert = {
    _id: "notification-customer-1",
    type: "message",
    unread: true,
    title: "Your message was received",
    message: "We will reply soon.",
    createdAt: new Date("2026-10-04T01:00:00.000Z"),
  };
  const fixture = loadController({ items: [customerAlert], role: "customer" });
  const res = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: {} }, res);

  assert.equal(res.data.notifications[0].id, "notification-customer-1");
  assert.equal(res.data.notifications[0]._id, undefined);
  assert.equal(res.data.notifications[0].unread, true);
});

test("Superadmin operations inbox includes older alerts while compact drawers stay limited", async () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    _id: `notification-${index}`,
    type: "system",
    title: `Distinct alert ${index}`,
    message: `Detail ${index}`,
    createdAt: new Date("2026-10-04T01:00:00.000Z"),
  }));
  const fixture = loadController({ items, role: "superadmin" });
  const full = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: { scope: "operations" } }, full);
  assert.equal(full.data.notifications.length, 120);
  assert.equal(fixture.queryLimits.length, 0);

  const compact = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: {} }, compact);
  assert.equal(compact.data.notifications.length, 30);
  assert.deepEqual(fixture.queryLimits, [100]);
});

test("operations scope cannot expand another role's notification drawer", async () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ _id: `n-${index}`, type: "system", title: `Alert ${index}` }));
  const fixture = loadController({ items, role: "admin" });
  const res = response();
  await fixture.controller.listMyNotifications({ authUser: { _id: "user-1" }, query: { scope: "operations" } }, res);
  assert.equal(res.data.notifications.length, 30);
  assert.deepEqual(fixture.queryLimits, [100]);
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
