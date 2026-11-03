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

test('dashboard rejects invalid branches and dates without running database work', async () => {
  for (const query of [{ branch: 'Not a branch' }, { from: '2026-10-01' }, { from: '2026-10-20', to: '2026-10-01' }, { from: '2099-01-01', to: '2099-01-02' }]) {
    const res = response();
    await getMyDashboard({ authUser: { role: 'superadmin' }, query }, res);
    assert.equal(res.statusCode, 400);
  }
});
