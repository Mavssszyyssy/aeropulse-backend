const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const ContactMessage = require("../src/models/ContactMessage");
const { listMyContactMessages } = require("../src/controllers/contactMessageController");

test("customer support history is scoped to the authenticated customer", async (t) => {
  const customer = new mongoose.Types.ObjectId();
  let filter;
  let limit;
  t.mock.method(ContactMessage, "find", (value) => {
    filter = value;
    return {
      select() { return this; },
      sort() { return this; },
      limit(value) { limit = value; return Promise.resolve([{ ticketCode: "MSG-123", subject: "Help", status: "new" }]); },
    };
  });
  let response;
  await listMyContactMessages({ authUser: { _id: customer } }, {
    json(value) { response = value; return value; },
    status() { throw new Error("Unexpected error response"); },
  });
  assert.deepEqual(filter, { customer });
  assert.equal(limit, 100);
  assert.equal(response.messages[0].ticketCode, "MSG-123");
});
