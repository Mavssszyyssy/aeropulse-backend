const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Order = require("../src/models/Order");
const Product = require("../src/models/Product");
const Task = require("../src/models/Task");
const User = require("../src/models/User");
const { listMyOrders } = require("../src/controllers/orderController");

test("customer order list is bounded and skips heavy task/provider data", async (t) => {
  const customerId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  let selected = "";
  let appliedLimit = 0;
  let appliedSkip = -1;
  let taskReads = 0;
  const query = {
    select(value) {
      selected = value;
      return this;
    },
    sort() {
      return this;
    },
    skip(value) {
      appliedSkip = value;
      return this;
    },
    limit(value) {
      appliedLimit = value;
      return this;
    },
    lean() {
      return Promise.resolve([{
        _id: orderId,
        orderCode: "ORD-CUSTOMER-1",
        customer: customerId,
        customerName: "Customer",
        items: [],
        paymentMethod: "cod",
        paymentStatus: "pending",
        workflowStatus: "to_pay",
        fulfillmentTimeline: [],
        receipt: {},
        totalAmount: 100,
        createdAt: new Date("2026-09-14T00:00:00.000Z"),
        updatedAt: new Date("2026-09-14T00:00:00.000Z"),
      }]);
    },
  };

  t.mock.method(Order, "find", () => query);
  t.mock.method(Order, "countDocuments", async () => 1);
  t.mock.method(Product, "aggregate", async () => []);
  t.mock.method(User, "find", () => ({
    select() { return this; },
    lean: async () => [],
  }));
  t.mock.method(Task, "find", () => {
    taskReads += 1;
    throw new Error("Customer list must not load linked task documents.");
  });

  let body;
  const headers = {};
  await listMyOrders(
    { authUser: { _id: customerId, role: "customer" }, query: {} },
    {
      set(name, value) { headers[name] = value; },
      json(value) { body = value; return value; },
    },
  );

  assert.match(selected, /-paymongo\.raw/);
  assert.match(selected, /-proofOfPayment\.imageUrl/);
  assert.equal(appliedLimit, 100);
  assert.equal(appliedSkip, 0);
  assert.equal(taskReads, 0);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(body.orders[0].id, String(orderId));
  assert.deepEqual(body.pagination, { page: 1, limit: 100, total: 1, totalPages: 1 });

  const customerIndex = Order.schema.indexes().find(([fields]) =>
    fields.customer === 1 && fields.createdAt === -1
  );
  assert.ok(customerIndex, "customer newest-order index must exist");
});

test("customer order pagination skips to the requested page without broadening ownership", async (t) => {
  const customerId = new mongoose.Types.ObjectId();
  let filter;
  let skip;
  let limit;
  t.mock.method(Order, "find", (value) => {
    filter = value;
    return {
      select() { return this; },
      sort() { return this; },
      skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; },
      lean: async () => [],
    };
  });
  t.mock.method(Order, "countDocuments", async () => 25);
  let body;
  await listMyOrders({ authUser: { _id: customerId }, query: { page: "2", limit: "10" } }, {
    set() {},
    json(value) { body = value; return value; },
  });
  assert.deepEqual(filter, { customer: customerId });
  assert.equal(skip, 10);
  assert.equal(limit, 10);
  assert.deepEqual(body.pagination, { page: 2, limit: 10, total: 25, totalPages: 3 });
});
