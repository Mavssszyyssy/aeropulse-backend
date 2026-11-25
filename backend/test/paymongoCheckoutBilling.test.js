const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const env = require("../src/config/env");
const { createCheckoutSession } = require("../src/services/paymongoClient");

const order = () => ({
  _id: "order-fixture", customer: "customer-fixture", customerName: "Maria Santos",
  orderCode: "ORD-FIXTURE", paymentMethod: "gcash",
  items: [{ name: "Inverter AC", price: 32000, quantity: 1, specs: "2.5 HP" }],
  vatAmount: 3840, shippingFee: 380, totalAmount: 36220,
  address: { name: "Different Recipient", phone: "09999999999", street: "Delivery street" },
});

function captureCheckout(t) {
  const previous = { paymongoMode: env.paymongoMode, paymongoSecretKey: env.paymongoSecretKey };
  Object.assign(env, { paymongoMode: "test", paymongoSecretKey: "sk_test_fixture" });
  t.after(() => Object.assign(env, previous));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ data: { id: "cs_fixture", attributes: {
      checkout_url: "https://checkout.paymongo.com/fixture", status: "active", livemode: false,
    } } }) };
  });
  return requests;
}

test("checkout prefills authenticated payer details without changing totals, method or app return URLs", async (t) => {
  const requests = captureCheckout(t);
  const input = order();
  const customer = {
    name: "Maria Santos Jr.", email: "MARIA@EXAMPLE.COM", phone: "09171234567",
    billingAddress: { street: "Billing street", barangay: "Central", city: "Plaridel", province: "Bulacan", postalCode: "3004" },
    passwordHash: "not-payment-data", role: "customer",
  };
  const result = await createCheckoutSession({
    order: input, customer,
    successUrl: "https://api.example/api/orders/order-fixture/paymongo/return?payment=success&target=mobile",
    cancelUrl: "https://api.example/api/orders/order-fixture/paymongo/return?payment=cancelled&target=mobile",
  });
  const a = requests[0].body.data.attributes;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, `${env.paymongoApiBaseUrl}/v2/checkout_sessions`);
  assert.deepEqual(a.billing, {
    name: "Maria Santos Jr.", email: "maria@example.com", phone: "+639171234567",
    address: { line1: "Billing street", line2: "Central", city: "Plaridel", state: "Bulacan", postal_code: "3004", country: "PH" },
  });
  assert.deepEqual(a.payment_method_types, ["gcash"]);
  assert.equal(a.line_items.reduce((sum, item) => sum + item.amount * item.quantity, 0), 3622000);
  assert.match(a.success_url, /target=mobile$/);
  assert.match(a.cancel_url, /payment=cancelled&target=mobile$/);
  assert.equal(a.metadata.customer_id, "customer-fixture");
  assert.equal(JSON.stringify(a).includes("not-payment-data"), false);
  assert.equal(result.id, "cs_fixture");
  assert.equal(result.status, "active");
  assert.equal(input.paymentStatus, undefined, "Starting a checkout must not mark the order paid");
});

test("legacy checkout calls stay compatible and invalid optional contact/address values are not fabricated", async (t) => {
  const requests = captureCheckout(t);
  await createCheckoutSession({ order: order(), successUrl: "https://shop.example/success", cancelUrl: "https://shop.example/cancel" });
  assert.deepEqual(requests[0].body.data.attributes.billing, { name: "Maria Santos" });
  await createCheckoutSession({ order: order(), customer: {
    name_first: "Maria", name_last: "Santos", suffix: "III", email: "not-an-email", phone: "09171234567890",
    billingAddress: { street: "Incomplete address" },
  } });
  assert.deepEqual(requests[1].body.data.attributes.billing, { name: "Maria Santos III" });
});

test("both initial checkout and retries pass the authenticated account through the shared server helper", async () => {
  const source = fs.readFileSync(require.resolve("../src/controllers/orderController"), "utf8");
  const start = source.indexOf("const attachPaymongoCheckout =");
  const helper = source.slice(start, source.indexOf("\n};", start) + 3);
  const authenticated = { id: "customer-fixture", name: "Maria Santos", email: "maria@example.com" };
  let checkoutInput;
  const attach = vm.runInNewContext(`${helper}; attachPaymongoCheckout`, {
    isOnlinePaymentMethod: () => true, isPaymongoConfigured: () => true,
    buildPaymentReturnUrls: () => ({ successUrl: "https://shop.example/success", cancelUrl: "https://shop.example/cancel" }),
    createCheckoutSession: async input => { checkoutInput = input; return { id: "cs_fixture", checkoutUrl: "https://checkout.example", status: "active", raw: {} }; },
    PAYMONGO_CHECKOUT_TIMEOUT_MS: 1800000, normalizePaymentReturnTarget: () => "mobile",
    Date, gcashPaymentAttemptCount: () => 0,
  });
  await attach({ ...order(), save: async () => {} }, { req: { authUser: authenticated }, returnTarget: "mobile" });
  assert.equal(checkoutInput.customer, authenticated);
  assert.match(source, /attachPaymongoCheckout\(order, \{\s+req,\s+returnTarget: checkoutReturnTarget/);
  assert.match(source, /attachPaymongoCheckout\(order, \{\s+req,\s+returnTarget: req.body/);
});
