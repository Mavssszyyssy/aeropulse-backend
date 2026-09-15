const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/controllers/orderController"), "utf8");
const routes = fs.readFileSync(require.resolve("../src/routes/ampRoutes"), "utf8");

test("online order email is gated by verified provider payment", () => {
  assert.match(source, /if \(!usesOnlinePayment && canSendEmail\(\)\)/);
  assert.match(source, /await sendConfirmedOnlinePaymentEmail\(order\);/);
  const paidStart = source.indexOf("if (isPaid) {");
  const failedStart = source.indexOf("if (isFailed) {", paidStart);
  const confirmedEmail = source.indexOf("await sendConfirmedOnlinePaymentEmail(order);", paidStart);
  assert.ok(paidStart >= 0 && confirmedEmail > paidStart && confirmedEmail < failedStart);
  assert.match(source, /subject: `Payment Confirmed - \$\{order\.orderCode\}`/);
  assert.doesNotMatch(source, /eventType === "checkout_session\.completed"/);
});

test("a completed checkout session is not enough to confirm payment", () => {
  const functionStart = source.indexOf("const checkoutSessionLooksPaid =");
  const functionEnd = source.indexOf("const checkoutSessionLooksClosed =", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const functionSource = `${source.slice(functionStart, functionEnd)}\ncheckoutSessionLooksPaid;`;
  const checkoutSessionLooksPaid = vm.runInNewContext(functionSource);

  assert.equal(checkoutSessionLooksPaid({ data: { attributes: { status: "completed" } } }), false);
  assert.equal(
    checkoutSessionLooksPaid({ data: { attributes: { payment_status: "paid" } } }),
    true,
  );
  assert.equal(
    checkoutSessionLooksPaid({
      data: { attributes: { status: "completed", payments: [{ attributes: { status: "paid" } }] } },
    }),
    true,
  );
});

test("customers cannot change technician-recorded room size through the API", () => {
  const roomRoute = routes.slice(routes.indexOf('"/units/:unitId/room-size"'), routes.indexOf('"/units/:unitId/complete-service"'));
  assert.match(roomRoute, /allowRoles\("technician", "admin", "superadmin"\)/);
  assert.doesNotMatch(roomRoute, /allowRoles\([^\n]*"customer"/);
});
