const test = require('node:test');
const assert = require('node:assert/strict');
const { orderEmail } = require('../src/services/orderEmailTemplates');

test('COD order email shows recipient, delivery and unpaid payment status safely', () => {
  const result = orderEmail({
    order: {
      orderCode: 'ORD-123', customerName: 'Pat Example', paymentMethod: 'cod',
      address: { name: 'Pat <Example>', street: '1 Main St', city: 'Cavite' },
      items: [{ name: 'AC Unit', quantity: 1, price: 100 }], totalAmount: 100,
    },
    title: 'Order received', introduction: 'Thank you for your order.',
    paymentLine: 'Cash on delivery · To be paid when your order arrives.',
  });
  assert.match(result.html, /Pat &lt;Example&gt;/);
  assert.doesNotMatch(result.html, /Pat <Example>/);
  assert.match(result.html, /Delivery address:<\/strong> 1 Main St, Cavite/);
  assert.match(result.text, /To be paid when your order arrives/);
  assert.match(result.text, /Recipient: Pat <Example>/);
  assert.match(result.text, /Payment method \/ channel: Cash on Delivery/);
  assert.match(result.text, /Payment status: To be paid on delivery/);
  assert.match(result.text, /Amount due: PHP 100\.00/);
  assert.match(result.text, /Pay the amount due when the order is delivered/);
  assert.doesNotMatch(result.text, /Payment reference:/);
  assert.doesNotMatch(result.text, /Payment amount:/);
});

test('verified payment email identifies the method, status, amount and date', () => {
  const result = orderEmail({
    order: {
      orderCode: 'ORD-9', paymentMethod: 'gcash', totalAmount: 3500,
      subtotalAmount: 3000, vatAmount: 300, shippingFee: 200,
      paymongo: { paidAt: '2026-11-10T00:00:00.000Z', paymentId: 'pay_123' }, items: [],
    },
    title: 'Payment confirmed', introduction: 'Your payment has been confirmed.', paymentLine: 'Paid online.', isPaid: true,
  });
  assert.match(result.text, /Payment method \/ channel: GCash/);
  assert.match(result.text, /Payment status: Paid/);
  assert.match(result.text, /Merchant: Cold Air Conditioning Trading/);
  assert.match(result.text, /Payment amount: PHP 3,500\.00/);
  assert.match(result.text, /Payment reference: pay_123/);
  assert.match(result.text, /Order reference: ORD-9/);
  assert.match(result.text, /Subtotal: PHP 3,000\.00/);
  assert.match(result.text, /VAT: PHP 300\.00/);
  assert.match(result.text, /Delivery: PHP 200\.00/);
  assert.match(result.text, /Transaction date:/);
  assert.match(result.text, /Total: PHP 3,500.00/);
  assert.match(result.html, /Payment confirmation/);
  assert.match(result.html, /pay_123/);
});
