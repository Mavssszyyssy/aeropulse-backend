const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const { acquisitionFromTracking, summarizeAcquisitionRows } = require('../src/domain/acquisitionAttribution');
const { buildCustomerAcquisitionPipeline, getCustomerAcquisitionBySource } = require('../src/controllers/dashboardController');

test('campaign-link attribution needs explicit recognized tracking, not an online signup', () => {
  assert.equal(acquisitionFromTracking(), 'unknown');
  assert.equal(acquisitionFromTracking({ utmSource: 'unknown-network' }), 'unknown');
  assert.equal(acquisitionFromTracking({ utmSource: 'facebook', utmMedium: 'organic' }), 'social_media');
  assert.equal(acquisitionFromTracking({ utmSource: 'instagram', utmMedium: 'paid_social' }), 'paid_advertisement');
  assert.equal(acquisitionFromTracking({ utmSource: 'friend', utmMedium: 'referral' }), 'friend_referral');
  assert.equal(acquisitionFromTracking({ utmSource: 'direct' }), 'direct_organic');
  assert.equal(acquisitionFromTracking({ utmSource: 'google' }), 'google');
  assert.equal(acquisitionFromTracking({ utmSource: 'x'.repeat(101), utmMedium: 'x'.repeat(101) }), 'unknown');
});

test('explicit Other stays separate from missing sources without losing unique customer counts', () => {
  const categories = summarizeAcquisitionRows([
    { _id: 'other', count: 3 }, { _id: null, count: 2 },
    { _id: 'social_media', count: 4 }, { _id: 'paid_advertisement', count: 1 },
  ]);
  assert.deepEqual(categories.find((item) => item.key === 'other'), { key: 'other', label: 'Other (recorded)', count: 3 });
  assert.deepEqual(categories.find((item) => item.key === 'unknown'), { key: 'unknown', label: 'Unknown / Not Tracked', count: 2 });
  assert.equal(categories.reduce((sum, item) => sum + item.count, 0), 10);
});

test('acquisition aggregation scopes one customer per record to branch and registration date', async () => {
  const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-20T23:59:59Z') };
  const pipeline = buildCustomerAcquisitionPipeline('Bulacan', range);
  assert.deepEqual(pipeline[0].$match, { role: 'customer', activeBranch: 'Bulacan', createdAt: { $gte: range.from, $lte: range.to } });
  assert.deepEqual(pipeline[1], { $group: { _id: '$sourceOfAcquisition', count: { $sum: 1 } } });
  const previousAggregate = User.aggregate;
  try {
    User.aggregate = async (actualPipeline) => {
      assert.deepEqual(actualPipeline, pipeline);
      return [{ _id: 'other', count: 2 }, { _id: 'friend_referral', count: 1 }];
    };
    const result = await getCustomerAcquisitionBySource('Bulacan', range);
    assert.equal(result.reduce((sum, item) => sum + item.count, 0), 3);
    assert.equal(result.find((item) => item.key === 'friend_referral').label, 'Referral');
  } finally {
    User.aggregate = previousAggregate;
  }
});
