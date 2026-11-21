const test = require("node:test");
const assert = require("node:assert/strict");
const ContactMessage = require("../src/models/ContactMessage");
const User = require("../src/models/User");
const { buildOperationalContactFilter } = require("../src/domain/operationalContactMessages");
const { listContactMessages, updateContactMessage } = require("../src/controllers/contactMessageController");

const reply = () => {
  const result = { code: 200, body: null };
  return {
    result,
    response: {
      status(code) { result.code = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
};

test("operational filter excludes explicit and legacy deleted messages, not disabled accounts", () => {
  const filter = buildOperationalContactFilter({ deletedCustomerIds: ["deleted-id"], scope: { branch: "Bulacan" } });
  assert.deepEqual(filter.$and[0], { hiddenFromOperationalInbox: { $ne: true } });
  assert.deepEqual(filter.$and[1], { customer: { $nin: ["deleted-id"] } });
  assert.deepEqual(filter.$and[3], { branch: "Bulacan" });
  assert.equal(filter.$and.length, 4);
  assert.equal(filter.$and[2].$nor[0].message, "Message removed with deleted account.");
});

test("staff list applies one operational scope to search, pagination and every status count", async (t) => {
  const filters = [];
  t.mock.method(User, "distinct", async (_field, query) => {
    assert.equal(query.role, "customer");
    assert.deepEqual(query.$or, [{ isDeleted: true }, { accountStatus: "deleted" }]);
    return ["deleted-id"];
  });
  t.mock.method(ContactMessage, "aggregate", async (pipeline) => {
    filters.push(pipeline[0].$match, pipeline[1].$facet.messages[0].$match);
    assert.deepEqual(pipeline[1].$facet.messages[2], { $skip: 20 });
    assert.deepEqual(pipeline[1].$facet.messages[3], { $limit: 20 });
    assert.deepEqual(pipeline[1].$facet.total[0].$match, pipeline[1].$facet.messages[0].$match);
    assert.deepEqual(pipeline[1].$facet.statuses, [{ $group: { _id: "$status", value: { $sum: 1 } } }]);
    return [{ messages: [], total: [{ value: 1 }], statuses: [{ _id: "new", value: 1 }, { _id: "in_progress", value: 1 }, { _id: "resolved", value: 1 }, { _id: "closed", value: 1 }] }];
  });
  t.mock.method(ContactMessage, "find", () => assert.fail("No separate list query"));
  t.mock.method(ContactMessage, "countDocuments", () => assert.fail("No separate status-count queries"));
  const { response, result } = reply();
  await listContactMessages({ authUser: { role: "admin" }, activeBranch: "Bulacan", query: { page: "2", status: "in_progress", search: "A+B" } }, response);
  assert.equal(result.code, 200);
  assert.equal(result.body.pagination.page, 2);
  assert.equal(result.body.counts.active, 1);
  assert.equal(result.body.counts.resolved, 2);
  assert.equal(filters.length, 2);
  assert.equal(result.body.counts.total, 4);
  for (const filter of filters) {
    assert.deepEqual(filter.$and[1], { customer: { $nin: ["deleted-id"] } });
    assert.deepEqual(filter.$and[3], { $or: [{ branch: "Bulacan" }, { branch: "" }] });
  }
  const search = filters[1].$and.at(-1).$or[0].ticketCode;
  assert.equal(search.test("A+B"), true);
  assert.equal(search.test("AAAB"), false);
});

test("direct staff update cannot reopen a deleted customer's conversation", async (t) => {
  t.mock.method(User, "distinct", async () => ["deleted-id"]);
  t.mock.method(ContactMessage, "findOne", async (filter) => {
    assert.deepEqual(filter.$and[1], { customer: { $nin: ["deleted-id"] } });
    return null;
  });
  const { response, result } = reply();
  await updateContactMessage({ authUser: { role: "superadmin" }, params: { id: "message-id" }, body: { status: "in_progress" } }, response);
  assert.equal(result.code, 404);
});

test("branch admin without a valid active branch cannot list or update messages", async (t) => {
  t.mock.method(ContactMessage, "find", () => { throw new Error("Messages must not be queried"); });
  t.mock.method(ContactMessage, "findOne", () => { throw new Error("Messages must not be queried"); });
  const listing = reply();
  await listContactMessages({ authUser: { role: "admin" }, activeBranch: "", query: {} }, listing.response);
  assert.equal(listing.result.code, 403);
  const update = reply();
  await updateContactMessage({ authUser: { role: "admin" }, activeBranch: "", params: { id: "message-id" }, body: {} }, update.response);
  assert.equal(update.result.code, 403);
});

test("admin and superadmin replies reject invalid content before changing status or saving", async (t) => {
  t.mock.method(User, "distinct", async () => []);
  const item = { status: "new", adminReply: "", timeline: [], save: t.mock.fn(async () => {}) };
  t.mock.method(ContactMessage, "findOne", async () => item);
  for (const role of ["admin", "superadmin"]) {
    for (const adminReply of ["jhjhjh", "Jshshshshshsh", "Lorem ipsum dolor sit amet", "help ".repeat(151),
      "Please inspect this AC unit. ".repeat(50), { text: "Please inspect this AC unit." }]) {
      const { response, result } = reply();
      await updateContactMessage({ authUser: { role }, activeBranch: "Bulacan", params: { id: "message-id" }, body: { adminReply, status: "in_progress" } }, response);
      assert.equal(result.code, 400, String(adminReply));
      assert.equal(item.status, "new");
      assert.equal(item.adminReply, "");
    }
  }
  assert.equal(item.save.mock.callCount(), 0);
  assert.deepEqual(item.timeline, []);
  const unchanged = reply();
  await updateContactMessage({ authUser: { role: "superadmin" }, params: { id: "message-id" }, body: { status: "new" } }, unchanged.response);
  assert.equal(unchanged.result.code, 200);
  assert.equal(item.save.mock.callCount(), 1);
});
