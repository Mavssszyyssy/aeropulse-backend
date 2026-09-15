const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../src/controllers/orderController');
const source = fs.readFileSync(filename, 'utf8');
const start = source.indexOf('const buildTrackingTimeline =');
const end = source.indexOf('\n};', start) + 3;
const stages = ['placed', 'confirmed', 'preparing', 'dispatched', 'out_for_delivery', 'arrived', 'installation', 'completed', 'cancelled'];
const build = vm.runInNewContext(`${source.slice(start, end)}; buildTrackingTimeline`, { require: createRequire(filename), fulfillmentStages: Object.fromEntries(stages.map((stage) => [stage, stage])) });
const now = '2026-09-07T02:00:00Z';
const order = { createdAt: now, updatedAt: now, dispatchedAt: now, workflowStatus: 'to_install' };
const task = { status: 'in-progress', updatedAt: now, payload: { activatedAt: now } };
test('dispatch activates work but does not claim travel, arrival or installation', () => {
  assert.equal(build(order, task).currentStage, 'dispatched');
});
test('only a valid technician check-in advances arrival', () => {
  const arrived = { ...task, payload: { checkIn: { checkedInAt: now, latitude: 14.5, longitude: 121 } } };
  assert.equal(build(order, arrived).currentStage, 'arrived');
  assert.equal(build(order, arrived).timeline.some((event) => event.stage === 'out_for_delivery'), false);
  for (const latitude of [null, '', 100, undefined]) {
    assert.equal(build(order, { ...arrived, payload: { checkIn: { ...arrived.payload.checkIn, latitude } } }).currentStage, 'dispatched');
  }
});
test('a genuine on-the-way milestone remains before arrival when timestamps match', () => {
  const arrived = {
    ...task,
    status: 'in-progress',
    payload: { onTheWayAt: now, checkIn: { checkedInAt: now, latitude: 14.5, longitude: 121 } },
  };
  const result = build({
    ...order,
    fulfillmentTimeline: [
      { stage: 'arrived', timestamp: now },
      { stage: 'out_for_delivery', timestamp: now },
    ],
  }, arrived);
  assert.equal(result.timeline.map((event) => event.stage).join(','), 'placed,confirmed,preparing,dispatched,out_for_delivery,arrived');
  assert.equal(result.currentStage, 'arrived');
});
test('legacy inferred arrival events cannot override missing check-in evidence', () => {
  assert.equal(build({ ...order, fulfillmentTimeline: [{ stage: 'arrived', timestamp: now }, { stage: 'installation', timestamp: now }] }, task).currentStage, 'dispatched');
});
