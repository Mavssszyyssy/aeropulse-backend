const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildOrderPaymentSnapshot,
  orderIsPaid,
  resolveOrderPaymentStatus,
} = require("../src/domain/orderPayment");

test("confirmed PayMongo payments override a stale pending status", () => {
  for (const paymentMethod of ["gcash", "card"]) {
    const order = {
      paymentMethod,
      paymentProvider: "paymongo",
      paymentStatus: "pending",
      totalAmount: 25000,
      paymongo: {
        paidAt: "2026-09-13T02:00:00.000Z",
        referenceNumber: `PAY-${paymentMethod}`,
      },
    };
    assert.equal(resolveOrderPaymentStatus(order), "paid");
    assert.equal(orderIsPaid(order), true);
    assert.deepEqual(buildOrderPaymentSnapshot(order), {
      method: paymentMethod,
      provider: "paymongo",
      status: "paid",
      amount: 25000,
      paidAt: "2026-09-13T02:00:00.000Z",
      reference: `PAY-${paymentMethod}`,
    });
  }
});

test("an unconfirmed online payment remains pending", () => {
  assert.equal(resolveOrderPaymentStatus({ paymentMethod: "gcash", paymentStatus: "pending" }), "pending");
  assert.equal(orderIsPaid({ paymentMethod: "card", paymentStatus: "failed" }), false);
});
