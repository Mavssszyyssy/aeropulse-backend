const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { registerPushToken, unregisterPushToken } = require("../src/controllers/notificationController");
const { sendPushForNotification } = require("../src/services/pushNotificationService");

function response() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("push tokens are excluded from ordinary account reads and JSON responses", () => {
  assert.equal(User.schema.path("expoPushTokens").options.select, false);
  const user = new User({ expoPushTokens: ["ExponentPushToken[private]"] });
  assert.equal(user.toJSON().expoPushTokens, undefined);
});

test("registration moves a token to the authenticated account and sign-out removes only its token", async (t) => {
  const originalUpdateMany = User.updateMany;
  const originalUpdateOne = User.updateOne;
  const operations = [];
  User.updateMany = async (...args) => { operations.push(["move", ...args]); };
  User.updateOne = async (...args) => { operations.push(["update", ...args]); };
  t.after(() => { User.updateMany = originalUpdateMany; User.updateOne = originalUpdateOne; });

  const req = { authUser: { _id: "customer-1" }, body: { expoPushToken: "ExponentPushToken[device-1]" } };
  assert.equal((await registerPushToken(req, response())).code, 200);
  assert.deepEqual(operations[0], ["move",
    { _id: { $ne: "customer-1" }, expoPushTokens: "ExponentPushToken[device-1]" },
    { $pull: { expoPushTokens: "ExponentPushToken[device-1]" } },
  ]);
  assert.deepEqual(operations[1], ["update",
    { _id: "customer-1" }, { $addToSet: { expoPushTokens: "ExponentPushToken[device-1]" } },
  ]);
  assert.equal((await unregisterPushToken(req, response())).code, 200);
  assert.deepEqual(operations[2], ["update",
    { _id: "customer-1" }, { $pull: { expoPushTokens: "ExponentPushToken[device-1]" } },
  ]);
});

test("invalid push tokens are rejected before any user record changes", async (t) => {
  const originalUpdateMany = User.updateMany;
  User.updateMany = () => { throw new Error("must not write"); };
  t.after(() => { User.updateMany = originalUpdateMany; });
  const result = await registerPushToken({ authUser: { _id: "customer-1" }, body: { expoPushToken: "bad-token" } }, response());
  assert.equal(result.code, 400);
});

test("Expo unregistered-device ticket retires only that recipient's expired token", async (t) => {
  const originalFindById = User.findById;
  const originalUpdateOne = User.updateOne;
  const writes = [];
  User.findById = () => ({ select: async () => ({
    role: "technician",
    notifications: {},
    expoPushTokens: ["ExponentPushToken[expired]", "ExponentPushToken[active]"],
  }) });
  User.updateOne = async (...args) => { writes.push(args); };
  t.after(() => { User.findById = originalFindById; User.updateOne = originalUpdateOne; });
  let posted;
  const fetchImpl = async (_url, options) => {
    posted = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [
      { status: "error", details: { error: "DeviceNotRegistered" } },
      { status: "ok", id: "ticket-2" },
    ] }) };
  };
  await sendPushForNotification({
    _id: "notification-1", user: "technician-1", type: "technician",
    title: "Assignment", message: "Your work order is ready.", route: "/customer/orders",
  }, { fetchImpl });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].data.recipientId, "technician-1");
  assert.equal(posted[0].data.route, "/technician/tasks");
  assert.deepEqual(writes, [[
    { _id: "technician-1" },
    { $pull: { expoPushTokens: { $in: ["ExponentPushToken[expired]"] } } },
  ]]);
});

test("disabled accounts and opted-out recipients are never sent a push", async (t) => {
  const originalFindById = User.findById;
  let user = { role: "customer", accountStatus: "disabled", expoPushTokens: ["ExponentPushToken[device-1]"] };
  User.findById = () => ({ select: async () => user });
  t.after(() => { User.findById = originalFindById; });
  let sends = 0;
  const fetchImpl = async () => { sends += 1; throw new Error("must not send"); };
  const notification = { user: "customer-1", title: "Order", message: "Ready", type: "order" };
  await sendPushForNotification(notification, { fetchImpl });
  user = { ...user, accountStatus: "active", notifications: { push: false } };
  await sendPushForNotification(notification, { fetchImpl });
  assert.equal(sends, 0);
});
