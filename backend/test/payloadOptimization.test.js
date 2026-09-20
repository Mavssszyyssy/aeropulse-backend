const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Order = require("../src/models/Order");
const {
  getMyOrderSummary,
  listOrdersForAdmin,
} = require("../src/controllers/orderController");

const jsonResponse = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(value) { this.data = value; return value; },
});

test("customer order summary is grouped in MongoDB without loading order documents", async (t) => {
  const customerId = new mongoose.Types.ObjectId();
  let pipeline = null;
  t.mock.method(Order, "aggregate", async (value) => {
    pipeline = value;
    return [
      { _id: "to_pay", count: 3 },
      { _id: "complete", count: 8 },
    ];
  });
  t.mock.method(Order, "find", () => {
    throw new Error("Summary must not load full order documents.");
  });

  const res = jsonResponse();
  await getMyOrderSummary({ authUser: { _id: customerId } }, res);

  assert.equal(pipeline[0].$match.customer, customerId);
  assert.deepEqual(pipeline[1], { $group: { _id: "$workflowStatus", count: { $sum: 1 } } });
  assert.equal(res.data.summary.toPay, 3);
  assert.equal(res.data.summary.complete, 8);
  assert.equal(res.data.summary.cancelled, 0);
});

test("compact admin order view transfers only screen fields and skips hydration", async (t) => {
  const orderId = new mongoose.Types.ObjectId();
  let projection = "";
  let appliedLimit = 0;
  const query = {
    select(value) { projection = value; return this; },
    sort() { return this; },
    limit(value) { appliedLimit = value; return this; },
    lean: async () => [{
      _id: orderId,
      orderCode: "ORD-COMPACT-1",
      customerName: "Customer",
      items: [{ name: "AC Unit", quantity: 1 }],
      paymentMethod: "cod",
      paymentStatus: "pending",
      workflowStatus: "to_pay",
      totalAmount: 1000,
      customerBranch: "Bulacan",
      stockSourceBranch: "Bulacan",
    }],
  };
  t.mock.method(Order, "find", () => query);

  const res = jsonResponse();
  await listOrdersForAdmin({
    authUser: { role: "superadmin" },
    query: { view: "compact", limit: "75" },
  }, res);

  assert.equal(appliedLimit, 75);
  assert.match(projection, /items\.name/);
  assert.match(projection, /workflowStatus/);
  assert.doesNotMatch(projection, /receipt|paymongo|fulfillmentTimeline|serialUnits/);
  assert.equal(res.data.compact, true);
  assert.equal(res.data.orders[0].id, String(orderId));
  assert.equal(res.data.orders[0].workflowLabel, "TO PAY");
});
