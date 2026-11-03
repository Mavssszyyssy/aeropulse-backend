const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Order = require('../src/models/Order');
const {
  MAX_GCASH_PAYMENT_ATTEMPTS,
  GCASH_PAYMENT_LIMIT_MESSAGE,
  gcashPaymentAttemptCount,
  gcashPaymentAttemptsRemaining,
  gcashRetryLimitReached,
  gcashRetryableStatus,
} = require('../src/domain/gcashPaymentAttempts');

const source = fs.readFileSync(require.resolve('../src/controllers/orderController'), 'utf8');

test('orders use only the assigned branch and give the required zero-stock message', () => {
  assert.match(source, /const finalBranch = preferredBranch;/);
  assert.match(source, /This branch currently has no stock of this item/);
  assert.doesNotMatch(source, /Tried preferred and nearby branches/);
  assert.doesNotMatch(source, /deferStockUntilDispatch/);
  assert.match(source, /stockReservationStatus: "reserved"/);
});

test('GCash has three total checkout attempts including the original session', () => {
  const retryAttempts = Order.schema.path('paymongo.retryAttempts');
  assert.equal(retryAttempts.defaultValue, 0);
  assert.equal(MAX_GCASH_PAYMENT_ATTEMPTS, 3);
  assert.equal(gcashPaymentAttemptCount({ paymongo: { checkoutSessionId: 'cs_original', retryAttempts: 0 } }), 1);
  assert.equal(gcashPaymentAttemptCount({ paymongo: { checkoutSessionId: 'cs_third', retryAttempts: 3 } }), 3);
  assert.equal(gcashPaymentAttemptsRemaining({ paymongo: { checkoutSessionId: 'cs_original', retryAttempts: 1 } }), 2);
  assert.equal(gcashRetryLimitReached({ paymongo: { checkoutSessionId: 'cs_third', retryAttempts: 3 } }), true);
  assert.equal(gcashRetryableStatus('pending'), true);
  assert.equal(GCASH_PAYMENT_LIMIT_MESSAGE, 'Maximum payment attempts reached. You can no longer retry payment for this order.');
  assert.match(source, /PAYMENT_RETRY_LIMIT_REACHED/);
  assert.match(source, /resumedCheckout: true/);
  assert.match(source, /paymentStatus: \{ \$in: \["failed", "cancelled", "expired"\] \}/);
  assert.match(source, /paymentAttemptAlreadyCounted: isGcash/);
  assert.match(source, /"paymongo\.retryInProgress": true/);
  assert.match(source, /"paymongo\.retryInProgress": \{ \$ne: true \}/);
  assert.match(source, /paymentStatus: nextPaymentStatus/);
  assert.match(source, /amountPaid: 0/);
});
