const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/controllers/orderController'), 'utf8');
const start = source.indexOf('const applyPaymongoEventToOrder =');
const applySource = source.slice(start, source.indexOf('\n};', start) + 3);

test('late failure from an older checkout cannot cancel the current retry', async () => {
  let saves = 0;
  const order = {
    paymentStatus: 'pending',
    stockReservationStatus: 'reserved',
    paymongo: { checkoutSessionId: 'new-session', status: 'active' },
    async save() { saves += 1; },
  };
  const apply = vm.runInNewContext(`${applySource}; applyPaymongoEventToOrder`);
  const result = await apply(order, {
    eventType: 'checkout_session.expired',
    checkoutSessionId: 'old-session',
    resourceId: 'old-session',
    attributes: { status: 'expired' },
  });
  assert.equal(result, order);
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.paymongo.checkoutSessionId, 'new-session');
  assert.equal(order.stockReservationStatus, 'reserved');
  assert.equal(saves, 0);

  order.paymongo.retryAttempts = 2;
  await apply(order, {
    eventType: 'payment.failed',
    paymentId: 'unlinked-old-payment',
    resourceId: 'unlinked-old-payment',
    attributes: { status: 'failed' },
  });
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(saves, 0);
});

test('card retries claim an exclusive checkout slot before opening PayMongo', async () => {
  const retryStart = source.indexOf('const retryPaymongoCheckout =');
  const retrySource = source.slice(retryStart, source.indexOf('\n};', retryStart) + 3);
  let claimedQuery;
  const order = { _id: 'order-1', customer: 'customer-1', paymentMethod: 'card', paymentStatus: 'failed', workflowStatus: 'to_pay', stockReservationStatus: 'released' };
  const retry = vm.runInNewContext(`${retrySource}; retryPaymongoCheckout`, {
    Order: {
      findOne: async () => order,
      findOneAndUpdate: async (query) => { claimedQuery = query; return null; },
    },
    isOnlinePaymentMethod: () => true,
    Date,
  });
  let status;
  let body;
  await retry({ params: { orderId: 'order-1' }, authUser: { _id: 'customer-1' } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'PAYMENT_RETRY_CHANGED');
  assert.deepEqual(Array.from(claimedQuery.paymentStatus.$in), ['failed', 'cancelled', 'expired']);
  assert.equal(claimedQuery.workflowStatus, 'to_pay');
  assert.equal(claimedQuery.$and[0].$or[0]['paymongo.retryInProgress'].$ne, true);
});

test('pending GCash resumes its existing checkout without creating another session', async () => {
  const retryStart = source.indexOf('const retryPaymongoCheckout =');
  const retrySource = source.slice(retryStart, source.indexOf('\n};', retryStart) + 3);
  const order = {
    _id: 'order-1', customer: 'customer-1', paymentMethod: 'gcash', paymentStatus: 'pending', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-1', checkoutUrl: 'https://checkout.example/test', status: 'active' },
  };
  let newCheckoutAttempts = 0;
  const retry = vm.runInNewContext(`${retrySource}; retryPaymongoCheckout`, {
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    hydrateOrdersWithInventoryQrCodes: async () => [{ id: 'order-1' }],
    gcashPaymentAttemptCount: () => 1,
    gcashPaymentAttemptsRemaining: () => 2,
    attachPaymongoCheckout: async () => { newCheckoutAttempts += 1; },
  });
  let body;
  await retry({ params: { orderId: 'order-1' }, authUser: { _id: 'customer-1' } }, {
    json(value) { body = value; return this; },
  });
  assert.equal(body.resumedCheckout, true);
  assert.equal(body.payment.checkoutUrl, 'https://checkout.example/test');
  assert.equal(newCheckoutAttempts, 0);
});

test('cancelled orders cannot resume an old checkout link', async () => {
  const retryStart = source.indexOf('const retryPaymongoCheckout =');
  const retrySource = source.slice(retryStart, source.indexOf('\n};', retryStart) + 3);
  const order = { _id: 'order-1', customer: 'customer-1', paymentMethod: 'gcash', paymentStatus: 'pending', workflowStatus: 'cancelled', paymongo: { checkoutSessionId: 'checkout-1', checkoutUrl: 'https://checkout.example/test' } };
  const retry = vm.runInNewContext(`${retrySource}; retryPaymongoCheckout`, {
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
  });
  let status;
  let body;
  await retry({ params: { orderId: 'order-1' }, authUser: { _id: 'customer-1' } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 409);
  assert.match(body.message, /no longer awaiting payment/);
});

test('idempotent replay of a failed payment sends the customer to the existing order', async () => {
  const createStart = source.indexOf('const createOrder =');
  const createSource = source.slice(createStart, source.indexOf('\n};', createStart) + 3);
  const create = vm.runInNewContext(`${createSource}; createOrder`, {
    Order: { findOne: async () => ({
      _id: 'existing-order', paymentMethod: 'gcash', paymentStatus: 'failed',
      paymongo: { checkoutUrl: 'https://checkout.example/expired' },
    }) },
    isOnlinePaymentMethod: () => true,
  });
  let status;
  let body;
  await create({ authUser: { _id: 'customer-1' }, body: { idempotencyKey: 'request-1' }, get: () => '' }, {
    set() { return this; },
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'ORDER_PAYMENT_RETRY_REQUIRED');
  assert.equal(body.orderId, 'existing-order');
});
