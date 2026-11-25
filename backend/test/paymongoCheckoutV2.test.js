const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const env = require("../src/config/env");
const { getCheckoutSession, expireCheckoutSession } = require("../src/services/paymongoClient");

const source = fs.readFileSync(require.resolve("../src/controllers/orderController"), "utf8");
function helper(name) {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("\n};", start) + 3);
}
const extract = vm.runInNewContext(`${helper("collectPaymongoIdentifiers")}\n${helper("extractPaymongoEvent")}\nextractPaymongoEvent`);
const resource = () => ({ id: "cs_existing", type: "checkout_session", attributes: {
  status: "active", reference_number: "ORD-REAL-ITEM", metadata: { order_id: "order-fixture", order_code: "ORD-REAL-ITEM" },
  payment_intent: { id: "pi_confirmed", attributes: { status: "succeeded" } },
  payments: [
    { id: "pay_failed", attributes: { status: "failed", amount: 3622000, currency: "PHP" } },
    { id: "pay_confirmed", attributes: { status: "paid", amount: 3622000, currency: "PHP" } },
  ],
} });

test("old and documented v2 webhook envelopes identify the same confirmed order and payment", () => {
  const oldEvent = { data: { id: "evt_old", type: "event", attributes: { type: "checkout_session.payment.paid", data: resource() } } };
  const v2Event = { event_type: "send.webhook", data: { type: "checkout_session.payment.paid", resource: "checkout_session", livemode: false, data: resource() } };
  const old = extract(oldEvent);
  const current = extract(v2Event);
  assert.deepEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(old)));
  assert.equal(current.eventType, "checkout_session.payment.paid");
  assert.equal(current.checkoutSessionId, "cs_existing");
  assert.equal(current.paymentIntentId, "pi_confirmed");
  assert.equal(current.paymentId, "pay_confirmed");
  assert.equal(current.orderId, "order-fixture");
});

test("v2 delivery notices do not turn an unpaid active checkout into a paid event", () => {
  const checkout = resource();
  checkout.attributes.payment_intent = null;
  checkout.attributes.payments = [];
  const event = extract({ event_type: "send.webhook", data: { type: "checkout_session.updated", data: checkout } });
  assert.equal(event.eventType, "checkout_session.updated");
  assert.equal(event.paymentId, "");
  assert.equal(event.paymentIntentId, "");
  const looksPaid = vm.runInNewContext(`${helper("checkoutSessionLooksPaid")}\ncheckoutSessionLooksPaid`);
  assert.equal(looksPaid({ data: checkout }), false);
});

test("signature verification remains required for v2 payloads and rejects tampering", () => {
  const signatureStart = source.indexOf("const parsePaymongoSignature =");
  const verifyEnd = source.indexOf("\n};", source.indexOf("const verifyPaymongoWebhookSignature =")) + 3;
  const verify = vm.runInNewContext(`${source.slice(signatureStart, verifyEnd)}\nverifyPaymongoWebhookSignature`, {
    crypto, Buffer, Date, env: { paymongoMode: "test", paymongoWebhookSecret: "fixture-webhook-secret" },
    process: { env: {} }, HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  });
  const body = { event_type: "send.webhook", data: { type: "checkout_session.payment.paid", livemode: false, data: resource() } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac("sha256", "fixture-webhook-secret").update(`${timestamp}.${rawBody}`).digest("hex");
  const req = { body, rawBody, headers: { "paymongo-signature": `t=${timestamp},te=${digest}` } };
  assert.equal(verify(req), true);
  assert.throws(() => verify({ ...req, rawBody: Buffer.from("tampered") }), /Invalid PayMongo webhook signature/);
});

test("existing v1 and new v2 sessions retain compatible retrieval and expiration endpoints", async t => {
  const previous = { paymongoMode: env.paymongoMode, paymongoSecretKey: env.paymongoSecretKey };
  Object.assign(env, { paymongoMode: "test", paymongoSecretKey: "sk_test_fixture" });
  t.after(() => Object.assign(env, previous));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options.method });
    return { ok: true, json: async () => ({ data: { id: "cs_existing", attributes: { status: options.method === "POST" ? "expired" : "active" } } }) };
  });
  assert.equal((await getCheckoutSession("cs_existing")).data.attributes.status, "active");
  assert.equal((await expireCheckoutSession("cs_existing")).data.attributes.status, "expired");
  assert.deepEqual(calls, [
    { url: `${env.paymongoApiBaseUrl}/v1/checkout_sessions/cs_existing`, method: "GET" },
    { url: `${env.paymongoApiBaseUrl}/v1/checkout_sessions/cs_existing/expire`, method: "POST" },
  ]);
});
