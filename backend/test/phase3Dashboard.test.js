const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommerceAnalyticsPipeline, getMyDashboard, normalizeCommerceAnalytics } = require('../src/controllers/dashboardController');

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('branch and custom dates constrain the same order aggregation before sales facets', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-10-20T23:59:59Z');
  const pipeline = buildCommerceAnalyticsPipeline('Bulacan', { from, to });
  assert.deepEqual(pipeline[0].$match, { $or: [{ stockSourceBranch: 'Bulacan' }, { stockSourceBranch: { $in: ['', null] }, customerBranch: 'Bulacan' }] });
  assert.deepEqual(pipeline.find((stage) => stage.$match?._analyticsSalesDate).$match, { _analyticsSalesDate: { $gte: from, $lte: to } });
  assert.ok(pipeline.at(-1).$facet.branchProducts);
  assert.deepEqual(buildCommerceAnalyticsPipeline()[0].$match, {});
});

test('empty branch and paid-product facets preserve zero totals and actual quantities', () => {
  const empty = normalizeCommerceAnalytics({});
  assert.equal(empty.summary.revenue, 0);
  assert.deepEqual(empty.branches, []);
  const result = normalizeCommerceAnalytics({
    summary: [{ totalOrders: 3, paidOrders: 1, cancelledOrders: 1, revenue: 100 }],
    branches: [{ _id: 'Bulacan', orders: 3, paidOrders: 1, revenue: 100 }],
    branchProducts: [{ _id: { branch: 'Bulacan', productId: 'product-1', product: 'AC' }, quantity: 2, revenue: 120 }],
  });
  assert.equal(result.summary.cancelledOrders, 1);
  assert.deepEqual(result.branches[0].products, [{ productId: 'product-1', product: 'AC', quantity: 2, revenue: 120 }]);
});

test('cancelled KPI and pipeline use the same cancellation classification in one scoped facet', () => {
  const pipeline = buildCommerceAnalyticsPipeline('Bulacan', { from: new Date('2026-10-01'), to: new Date('2026-10-20') });
  const facet = pipeline.at(-1).$facet;
  assert.deepEqual(facet.summary[0].$group.cancelledOrders, { $sum: { $cond: ['$_analyticsCancelled', 1, 0] } });
  assert.equal(pipeline.find((stage) => stage.$set?._analyticsStage)?.$set._analyticsStage.$cond[0], '$_analyticsCancelled');
  const data = normalizeCommerceAnalytics({ summary: [{ cancelledOrders: 2 }], orderStages: [{ _id: 'cancelled', count: 2 }] });
  assert.equal(data.summary.cancelledOrders, data.orderStages.find((stage) => stage.key === 'cancelled').count);
});

test('pipeline includes dispatch and rescheduling stages so every valid order can reconcile', () => {
  const rows = [
    { _id: 'complete', count: 40 }, { _id: 'to_dispatch', count: 10 },
    { _id: 'for_rescheduling', count: 5 }, { _id: 'to_install', count: 30 },
    { _id: 'cancelled', count: 2 },
  ];
  const data = normalizeCommerceAnalytics({ summary: [{ totalOrders: 85, cancelledOrders: 2 }], orderStages: rows });
  assert.equal(data.orderStages.reduce((sum, row) => sum + row.count, 0), data.summary.totalOrders + data.summary.cancelledOrders);
  assert.equal(data.orderStages.find((row) => row.key === 'to_dispatch').count, 10);
  assert.equal(data.orderStages.find((row) => row.key === 'for_rescheduling').count, 5);
});

test('branch totals reconcile with pipeline, including cancelled and legacy stage records', () => {
  const branchFacet = buildCommerceAnalyticsPipeline().at(-1).$facet.branches;
  assert.equal(branchFacet.some((stage) => stage.$match), false);
  assert.deepEqual(branchFacet[0].$group.allOrders, { $sum: 1 });
  assert.deepEqual(branchFacet[0].$group.cancelledOrders, { $sum: { $cond: ['$_analyticsCancelled', 1, 0] } });
  const data = normalizeCommerceAnalytics({
    summary: [{ totalOrders: 92, cancelledOrders: 48, paidOrders: 60, revenue: 2500 }],
    orderStages: [
      { _id: 'to_pay', count: 24 }, { _id: 'to_deliver', count: 13 },
      { _id: 'to_dispatch', count: 3 }, { _id: 'to_install', count: 9 },
      { _id: 'for_rescheduling', count: 3 }, { _id: 'complete', count: 39 },
      { _id: 'legacy_stage', count: 1 }, { _id: 'cancelled', count: 48 },
    ],
    branches: [
      { _id: 'Bulacan', orders: 48, allOrders: 76, cancelledOrders: 28, paidOrders: 35, revenue: 1400 },
      { _id: 'Cavite', orders: 44, allOrders: 64, cancelledOrders: 20, paidOrders: 25, revenue: 1100 },
    ],
  });
  assert.equal(data.orderStages.find((stage) => stage.key === 'other_status').count, 1);
  assert.equal(data.orderStages.reduce((sum, stage) => sum + stage.count, 0), 140);
  assert.equal(data.branches.reduce((sum, branch) => sum + branch.allOrders, 0), 140);
  assert.equal(data.branches.reduce((sum, branch) => sum + branch.orders, 0), data.summary.totalOrders);
  assert.equal(data.branches.reduce((sum, branch) => sum + branch.cancelledOrders, 0), data.summary.cancelledOrders);
});

test('paid revenue and payment-method breakdown use the same order amounts and reconcile in cents', () => {
  const facet = buildCommerceAnalyticsPipeline().at(-1).$facet;
  assert.deepEqual(facet.summary[0].$group.revenue, {
    $sum: { $cond: ['$_analyticsPaid', '$_analyticsAmount', 0] },
  });
  assert.deepEqual(facet.paymentMethods[0], { $match: { _analyticsPaid: true } });
  assert.deepEqual(facet.paymentMethods[1].$group.revenue, { $sum: '$_analyticsAmount' });

  const data = normalizeCommerceAnalytics({
    summary: [{ paidOrders: 4, revenue: 2388762.75 }],
    paymentMethods: [
      { _id: 'GCASH', count: 1, revenue: 1000000.25 },
      { _id: 'COD', count: 1, revenue: 500000.25 },
      { _id: 'CREDIT', count: 1, revenue: 400000.25 },
      { _id: 'CARD', count: 1, revenue: 488762 },
    ],
  });
  assert.equal(data.paymentMethods.reduce((cents, row) => cents + Math.round(row.revenue * 100), 0), Math.round(data.summary.revenue * 100));
  assert.equal(data.paymentMethods.reduce((count, row) => count + row.count, 0), data.summary.paidOrders);
});

test('dashboard rejects invalid branches and dates without running database work', async () => {
  for (const query of [{ branch: 'Not a branch' }, { from: '2026-10-01' }, { from: '2026-10-20', to: '2026-10-01' }, { from: '2099-01-01', to: '2099-01-02' }]) {
    const res = response();
    await getMyDashboard({ authUser: { role: 'superadmin' }, query }, res);
    assert.equal(res.statusCode, 400);
  }
});
