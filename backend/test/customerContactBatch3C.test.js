const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const ContactMessage = require("../src/models/ContactMessage");
const { createContactMessage, listMyContactMessages, getMyContactMessage } = require("../src/controllers/contactMessageController");

const respond = () => {
  const result = { statusCode: 200 };
  result.res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return result;
};

test("invalid support inquiries are rejected before database writes or notifications", async () => {
  const cases = [
    [{ category: "unknown", subject: "Help", message: "Need help with my AC" }, /topic/],
    [{ category: "general", subject: "  ", message: "Need help with my AC" }, /required/],
    [{ category: "general", subject: "Hi", message: "Need help with my AC" }, /at least 3/],
    [{ category: "general", subject: "X".repeat(161), message: "Need help with my AC" }, /160/],
    [{ category: "general", subject: "Help", message: "  " }, /required/],
    [{ category: "general", subject: "Help", message: "X".repeat(3001) }, /3000/],
    [{ category: "general", subject: "Help", message: "short" }, /more detail/],
  ];
  for (const [body, expected] of cases) {
    const response = respond();
    await createContactMessage({ body, authUser: { _id: new mongoose.Types.ObjectId() } }, response.res);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, expected);
  }
});

test("customer history cursor is stable and scoped to owner", async (t) => {
  const owner = new mongoose.Types.ObjectId();
  const ids = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
  const createdAt = new Date("2026-10-01T00:00:00.000Z");
  let filter;
  let sort;
  let limit;
  t.mock.method(ContactMessage, "find", (value) => {
    filter = value;
    return { select() { return this; }, sort(value) { sort = value; return this; }, limit(value) {
      limit = value;
      return Promise.resolve(ids.map((_id) => ({ _id, createdAt, subject: "Help" })));
    } };
  });
  const first = respond();
  await listMyContactMessages({ authUser: { _id: owner }, query: { limit: "2" } }, first.res);
  assert.equal(limit, 3);
  assert.deepEqual(filter, { customer: owner });
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.equal(first.body.messages.length, 2);
  assert.equal(first.body.pagination.nextCursor, `${createdAt.toISOString()}|${ids[1]}`);

  const second = respond();
  await listMyContactMessages({ authUser: { _id: owner }, query: { limit: "2", before: first.body.pagination.nextCursor } }, second.res);
  assert.equal(String(filter.customer), String(owner));
  assert.deepEqual(filter.$or, [
    { createdAt: { $lt: createdAt } },
    { createdAt, _id: { $lt: String(ids[1]) } },
  ]);
});

test("individual conversation details require customer ownership", async (t) => {
  const owner = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  let filter;
  t.mock.method(ContactMessage, "findOne", (value) => {
    filter = value;
    return { select: async () => null };
  });
  const response = respond();
  await getMyContactMessage({ authUser: { _id: owner }, params: { id: String(id) } }, response.res);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(filter, { _id: String(id), customer: owner });
});
