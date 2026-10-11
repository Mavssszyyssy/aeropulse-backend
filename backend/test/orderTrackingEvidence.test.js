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
const reconcileStart = source.indexOf('const reconcileReopenedInstallationTracking =');
const reconcileEnd = source.indexOf('\n};', reconcileStart) + 3;
const reconcile = vm.runInNewContext(`${source.slice(reconcileStart, reconcileEnd)}; reconcileReopenedInstallationTracking`);
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

test('completed tracking stays in lifecycle order even when legacy timestamps are out of sequence', () => {
  const result = build({
    createdAt: '2026-10-04T04:49:04Z',
    updatedAt: '2026-10-04T05:01:01Z',
    dispatchedAt: '2026-10-04T04:52:08Z',
    workflowStatus: 'complete',
    fulfillmentTimeline: [
      { stage: 'dispatched', timestamp: '2026-10-04T04:52:08Z' },
      { stage: 'arrived', timestamp: '2026-10-04T04:58:48Z' },
      { stage: 'installation', timestamp: '2026-10-04T04:59:24Z' },
      { stage: 'completed', timestamp: '2026-10-04T05:00:58Z' },
    ],
  }, {
    status: 'completed',
    completedAt: '2026-10-04T05:00:58Z',
    payload: {
      checkIn: { checkedInAt: '2026-10-04T04:58:48Z', latitude: 14.5, longitude: 121 },
      installationStartedAt: '2026-10-04T04:59:24Z',
    },
  });

  assert.equal(result.timeline.map((event) => event.stage).join(','), 'placed,confirmed,preparing,dispatched,arrived,installation,completed');
  assert.equal(result.currentStage, 'completed');
  assert.equal(result.timeline.find((event) => event.stage === 'confirmed').timestamp, '2026-10-04T04:52:08Z');
  assert.equal(result.timeline.find((event) => event.stage === 'preparing').timestamp, '2026-10-04T04:52:08Z');
});

test('canonical stage order wins over impossible stored timestamp order', () => {
  const result = build({
    createdAt: '2026-10-04T04:49:04Z',
    updatedAt: '2026-10-04T05:01:01Z',
    dispatchedAt: '2026-10-04T04:52:08Z',
    workflowStatus: 'complete',
    fulfillmentTimeline: [
      { stage: 'completed', timestamp: '2026-10-04T05:00:58Z' },
      { stage: 'confirmed', timestamp: '2026-10-04T05:01:01Z' },
      { stage: 'preparing', timestamp: '2026-10-04T05:01:01Z' },
      { stage: 'dispatched', timestamp: '2026-10-04T04:52:08Z' },
    ],
  });

  assert.equal(result.timeline.map((event) => event.stage).join(','), 'placed,confirmed,preparing,dispatched,completed');
  assert.equal(result.currentStage, 'completed');
});

test('a later failed visit removes a stale completed outcome without rewriting stored history', () => {
  const reopened = { workflowStatus: 'complete', deliveryStatus: 'delivered' };
  const result = reconcile(reopened, {
    timeline: [
      { stage: 'completed', timestamp: '2026-10-09T10:00:00Z' },
      { stage: 'visit:failed', label: 'Failed to Install', timestamp: '2026-10-09T11:00:00Z' },
    ],
    currentStage: 'visit:failed',
  });
  assert.equal(reopened.workflowStatus, 'for_rescheduling');
  assert.equal(result.timeline.some((event) => event.stage === 'completed'), false);
  assert.equal(result.currentLabel, 'Failed to Install');
});

test('a later confirmed revisit supersedes completed but does not alter a reconciled workflow', () => {
  const reopened = { workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' };
  const result = reconcile(reopened, {
    timeline: [
      { stage: 'completed', timestamp: '2026-10-09T10:00:00Z' },
      { stage: 'visit:scheduled', label: 'Installation revisit confirmed', timestamp: '2026-10-09T12:00:00Z' },
    ],
  });
  assert.equal(reopened.workflowStatus, 'to_dispatch');
  assert.equal(result.timeline.length, 1);
  assert.equal(result.currentLabel, 'Installation revisit confirmed');
});
