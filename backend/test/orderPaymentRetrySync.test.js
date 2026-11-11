const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/controllers/orderController'), 'utf8');
const start = source.indexOf('const applyPaymongoEventToOrder =');
const applySource = source.slice(start, source.indexOf('\n};', start) + 3);

const loadRetry = (context) => {
  const helperSource = [
    'checkoutHasPaymentInFlight',
    'checkoutExpiryAt',
    'expireAbandonedCheckoutIfDue',
    'retryPaymongoCheckout',
  ].map((name) => {
    const start = source.indexOf(`const ${name} =`);
    return source.slice(start, source.indexOf('\n};', start) + 3);
  }).join('\n');
  const httpErrorStart = source.indexOf('class HttpError extends Error');
  const httpError = source.slice(httpErrorStart, source.indexOf('\n}', httpErrorStart) + 2);
  return vm.runInNewContext(`${httpError}\n${helperSource}\nretryPaymongoCheckout`, {
    PaymongoError: class extends Error {},
    console,
    ...context,
  });
};

test('a failed payment attempt does not close an active PayMongo session', () => {
  const closedStart = source.indexOf('const checkoutSessionLooksClosed =');
  const closedSource = source.slice(closedStart, source.indexOf('\n};', closedStart) + 3);
  const looksClosed = vm.runInNewContext(`${closedSource}; checkoutSessionLooksClosed`);
  assert.equal(looksClosed({ data: { attributes: { status: 'active', payment_status: 'failed' } } }), false);
  assert.equal(looksClosed({ data: { attributes: { status: 'expired' } } }), true);
});

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
  let claimedQuery;
  const order = { _id: 'order-1', customer: 'customer-1', paymentMethod: 'card', paymentStatus: 'failed', workflowStatus: 'to_pay', stockReservationStatus: 'released' };
  const retry = loadRetry({
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
  const order = {
    _id: 'order-1', customer: 'customer-1', paymentMethod: 'gcash', paymentStatus: 'pending', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-1', checkoutUrl: 'https://checkout.example/test', status: 'active' },
  };
  let newCheckoutAttempts = 0;
  const retry = loadRetry({
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => ({ data: { id: 'checkout-1', attributes: { status: 'active' } } }),
    checkoutSessionLooksPaid: () => false,
    checkoutSessionLooksClosed: () => false,
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

test('pending card payment reopens the same active checkout without creating a new charge', async () => {
  const order = {
    _id: 'order-card', customer: 'customer-1', paymentMethod: 'card', paymentStatus: 'pending', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-card', checkoutUrl: 'https://checkout.example/card' },
  };
  let providerChecks = 0;
  let newCheckoutAttempts = 0;
  const retry = loadRetry({
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => { providerChecks += 1; return { data: { id: 'checkout-card', attributes: { status: 'active' } } }; },
    checkoutSessionLooksPaid: () => false,
    checkoutSessionLooksClosed: () => false,
    hydrateOrdersWithInventoryQrCodes: async () => [{ id: 'order-card' }],
    attachPaymongoCheckout: async () => { newCheckoutAttempts += 1; },
  });
  let body;
  await retry({ params: { orderId: 'order-card' }, authUser: { _id: 'customer-1' } }, {
    json(value) { body = value; return this; },
  });
  assert.equal(body.resumedCheckout, true);
  assert.equal(body.payment.checkoutUrl, 'https://checkout.example/card');
  assert.equal(providerChecks, 1);
  assert.equal(newCheckoutAttempts, 0);
});

test('a provider-confirmed paid session is never reopened for another payment', async () => {
  const order = {
    _id: 'order-paid', customer: 'customer-1', paymentMethod: 'card', paymentStatus: 'pending', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-paid', checkoutUrl: 'https://checkout.example/paid' },
  };
  let applied = 0;
  const retry = loadRetry({
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => ({ data: { id: 'checkout-paid', attributes: { status: 'active', payments: [{ status: 'paid' }] } } }),
    checkoutSessionLooksPaid: () => true,
    checkoutSessionLooksClosed: () => false,
    assertPaymongoAmountMatchesOrder: () => {},
    applyPaymongoEventToOrder: async () => { applied += 1; },
    buildEventFromCheckoutSession: () => ({ eventType: 'checkout_session.payment.paid' }),
  });
  let status;
  let body;
  await retry({ params: { orderId: 'order-paid' }, authUser: { _id: 'customer-1' } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'PAYMENT_RETRY_CHANGED');
  assert.equal(applied, 1);
});

test('a provider-confirmed expired session updates the order before allowing any new attempt', async () => {
  const order = {
    _id: 'order-expired', customer: 'customer-1', paymentMethod: 'card', paymentStatus: 'pending', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-expired', checkoutUrl: 'https://checkout.example/expired' },
  };
  let applied = 0;
  const retry = loadRetry({
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => ({ data: { id: 'checkout-expired', attributes: { status: 'expired' } } }),
    checkoutSessionLooksPaid: () => false,
    checkoutSessionLooksClosed: () => true,
    applyPaymongoEventToOrder: async () => { applied += 1; },
    buildEventFromCheckoutSession: () => ({ eventType: 'checkout_session.expired' }),
  });
  let status;
  await retry({ params: { orderId: 'order-expired' }, authUser: { _id: 'customer-1' } }, {
    status(value) { status = value; return this; },
    json() { return this; },
  });
  assert.equal(status, 409);
  assert.equal(applied, 1);
});

test('a locally failed order safely reuses its still-active PayMongo checkout', async () => {
  const order = {
    _id: 'order-failed-active', customer: 'customer-1', paymentMethod: 'card',
    paymentStatus: 'failed', workflowStatus: 'to_pay', stockReservationStatus: 'reserved',
    paymongo: { checkoutSessionId: 'checkout-active', checkoutUrl: 'https://checkout.example/retry', status: 'active' },
    async save() {},
  };
  let createdSessions = 0;
  const retry = loadRetry({
    Order: {
      findOne: async () => order,
      findOneAndUpdate: async () => { order.paymentStatus = 'pending'; return order; },
    },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => ({ data: { id: 'checkout-active', attributes: { status: 'active', payments: [{ attributes: { status: 'failed' } }] } } }),
    checkoutSessionLooksPaid: () => false,
    checkoutSessionLooksClosed: () => false,
    reReserveReleasedOrderInventory: async () => {},
    hydrateOrdersWithInventoryQrCodes: async () => [{ id: 'order-failed-active' }],
    attachPaymongoCheckout: async () => { createdSessions += 1; },
  });

  let body;
  await retry({ params: { orderId: order._id }, authUser: { _id: 'customer-1' }, body: {} }, {
    json(value) { body = value; return this; },
  });

  assert.equal(body.resumedCheckout, true);
  assert.equal(body.payment.checkoutSessionId, 'checkout-active');
  assert.equal(body.payment.checkoutUrl, 'https://checkout.example/retry');
  assert.equal(createdSessions, 0);
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.paymongo.retryInProgress, false);
});

test('a locally failed order cannot reopen a checkout with a processing payment intent', async () => {
  const order = {
    _id: 'order-processing', customer: 'customer-1', paymentMethod: 'card',
    paymentStatus: 'failed', workflowStatus: 'to_pay',
    paymongo: { checkoutSessionId: 'checkout-1', checkoutUrl: 'https://checkout.example/test' },
  };
  const retry = loadRetry({
    Order: { findOne: async () => order },
    isOnlinePaymentMethod: () => true,
    getCheckoutSession: async () => ({ data: { attributes: { status: 'active', payment_intent: { status: 'processing' } } } }),
    checkoutSessionLooksPaid: () => false,
    checkoutSessionLooksClosed: () => false,
  });
  let status;
  let body;
  await retry({ params: { orderId: order._id }, authUser: { _id: order.customer } }, {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'PAYMENT_RETRY_PROCESSING');
});

test('cancelled orders cannot resume an old checkout link', async () => {
  const order = { _id: 'order-1', customer: 'customer-1', paymentMethod: 'gcash', paymentStatus: 'pending', workflowStatus: 'cancelled', paymongo: { checkoutSessionId: 'checkout-1', checkoutUrl: 'https://checkout.example/test' } };
  const retry = loadRetry({
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
