const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { visitAttemptError, nextVisitError } = require('../src/domain/visitAttempt');
const { hasVerifiedTaskCheckIn } = require('../src/domain/taskWorkflow');
const taskId = '111111111111111111111111';
const attemptId = '222222222222222222222222';
const userId = '333333333333333333333333';
const requestId = '444444444444444444444444';
const checkIn = { latitude: 14.4, longitude: 120.9, checkedInAt: '2026-09-10T02:00:00.000Z' };
const input = { checkedInAt: checkIn.checkedInAt, outcome: 'close', note: 'Entrance locked; no one answered.', photo: { uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==' } };
const initial = () => ({ _id: taskId, taskCode: 'TSK-TEST', branch: 'Cavite', status: 'in-progress', assignedTechnicianId: userId, assignedTechnicianName: 'Test technician', customerId: userId, payload: { checkIn: { ...checkIn }, requestId } });

test('unattended visits require active GPS arrival, outcome, note and embedded photo', () => {
  assert.equal(visitAttemptError(initial(), input), '');
  assert.equal(visitAttemptError(initial(), { ...input, outcome: 'reschedule' }), '');
  assert.match(visitAttemptError(initial(), { ...input, checkedInAt: 'old-arrival' }), /arrival record changed/);
  for (const patch of [{ outcome: 'completed' }, { note: '' }, { note: 'x'.repeat(501) }, { photo: null }, { photo: { uri: 'https://example.com/photo.jpg' } }, { photo: { uri: 'data:image/jpeg;base64,invalid' } }]) assert.notEqual(visitAttemptError(initial(), { ...input, ...patch }), '');
  for (const task of [{ ...initial(), status: 'completed' }, { ...initial(), payload: {} }, { ...initial(), payload: { checkIn: { ...checkIn, latitude: 200 } } }]) assert.match(visitAttemptError(task, input), /GPS/);
  const task = initial(); task.payload.visitAttempt = { awaitingAdmin: true };
  assert.match(visitAttemptError(task, input), /Admin/);
  assert.equal(hasVerifiedTaskCheckIn(task), false);
});

test('new visits require a valid date and dropdown time, never technician free text', () => {
  assert.equal(nextVisitError({ scheduledDate: '2099-12-12', timeSlot: '10:00 AM – 12:00 PM' }), '');
  for (const value of [{}, { scheduledDate: '2020-01-01' }, { scheduledDate: '2099-02-30' }, { scheduledDate: '2099-01-01', timeSlot: 'anytime' }]) assert.notEqual(nextVisitError(value), '');
});

function fixture({ delivery = false } = {}) {
  let task = initial(); let attempt = null; let created = 0; let query;
  if (delivery) task.payload = { checkIn: { ...checkIn }, orderCode: 'ORDER-QA' };
  const events = [];
  const order = { _id: requestId, customer: userId, workflowStatus: 'to_install', paymentStatus: 'unpaid', fulfillmentTimeline: [], save: async () => {} };
  const request = { _id: requestId, customerId: userId, status: 'In Progress', payload: {}, save: async () => {} };
  const original = Module._load;
  const setPath = (object, path, value) => { const parts = path.split('.'); const last = parts.pop(); for (const part of parts) object = object[part] ||= {}; object[last] = value; };
  const mocks = {
    '../models/Task': {
      findOne: async value => { query = value; return task; },
      findOneAndUpdate: async (filter, update) => { if (filter.status !== task.status) return null; for (const [path, value] of Object.entries(update.$set)) setPath(task, path, value); return task; },
    },
    '../models/VisitAttempt': {
      findOne: async () => attempt,
      findOneAndUpdate: async (filter, update) => { if (!attempt) { created++; attempt = { ...update.$setOnInsert, _id: attemptId, submittedAt: new Date(), save: async () => {} }; } return attempt; },
    },
    '../models/ServiceRequest': { findById: async () => request },
    '../models/Order': { findOne: async () => delivery ? order : null },
    '../domain/taskScheduleConflict': { assertNoTaskScheduleConflict: async () => {} },
    '../services/operationalNotificationService': { notifyOperationalStaff: async event => events.push(event), createDedupedNotification: async event => events.push(event) },
  };
  const path = require.resolve('../src/controllers/visitAttemptController');
  delete require.cache[path];
  Module._load = function(name, ...rest) { return mocks[name] || original.call(this, name, ...rest); };
  let controller;
  try { controller = require(path); } finally { Module._load = original; delete require.cache[path]; }
  async function call(method, role, body = input) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
    await controller[method]({ params: { taskId }, authUser: { _id: userId, role }, activeBranch: 'Cavite', body }, res);
    return res;
  }
  return { call, task: () => task, attempt: () => attempt, request, order, events, created: () => created, query: () => query };
}

test('close saves proof, holds only the attempt, retains request and notifies branch staff and customer', async () => {
  const f = fixture(); const response = await f.call('submitVisitAttempt', 'technician');
  assert.equal(response.statusCode, 200);
  assert.equal(f.task().status, 'on-hold');
  assert.equal(f.task().payload.checkIn, null);
  assert.equal(f.request.status, 'In Progress');
  assert.equal(f.task().payload.serviceHistoryId, undefined);
  assert.equal(f.attempt().photo.uri, input.photo.uri);
  assert.deepEqual(f.attempt().checkIn, checkIn);
  assert.equal(f.request.payload.timeline.length, 1);
  assert.equal(f.events[0].branch, 'Cavite');
  assert.ok(f.query().$and.some(scope => scope.assignedTechnicianId === userId));
  await f.call('submitVisitAttempt', 'technician');
  assert.equal(f.created(), 1);
  assert.equal(f.request.payload.timeline.length, 1);
});

test('Admin reschedule resets arrival, syncs schedule and is retry-safe', async () => {
  const f = fixture(); await f.call('submitVisitAttempt', 'technician', { ...input, outcome: 'reschedule' });
  const body = { attemptId, scheduledDate: '2099-12-12', timeSlot: '10:00 AM – 12:00 PM' };
  const denied = await f.call('scheduleNextVisit', 'technician', body);
  assert.equal(denied.statusCode, 403);
  const result = await f.call('scheduleNextVisit', 'admin', body);
  assert.equal(result.statusCode, 200);
  assert.equal(f.task().status, 'in-progress');
  assert.equal(f.task().payload.visitAttempt.awaitingAdmin, false);
  assert.equal(hasVerifiedTaskCheckIn(f.task()), false);
  assert.equal(f.request.payload.scheduledDate, body.scheduledDate);
  assert.ok(f.query().$and.some(scope => scope.branch === 'Cavite'));
  assert.equal(f.attempt().resolution.confirmedBy, userId);
  assert.equal((await f.call('scheduleNextVisit', 'admin', body)).statusCode, 200);
  assert.equal(f.request.payload.timeline.length, 2);
  assert.ok(f.events.some(event => event.title === 'Next visit scheduled'));
  assert.equal(f.events.some(event => event.title === 'Installation revisit confirmed'), false);
});

test('cancelled work orders cannot reopen through visit follow-up', async () => {
  const f = fixture(); await f.call('submitVisitAttempt', 'technician'); f.task().status = 'cancelled';
  assert.equal((await f.call('scheduleNextVisit', 'superadmin', { attemptId, scheduledDate: '2099-12-12', timeSlot: '10:00 AM – 12:00 PM' })).statusCode, 409);
});

test('delivery attempt preserves payment and fulfillment while syncing next appointment and customer alerts', async () => {
  const f = fixture({ delivery: true });
  assert.equal((await f.call('submitVisitAttempt', 'technician')).statusCode, 200);
  assert.equal(f.order.workflowStatus, 'for_rescheduling');
  assert.equal(f.order.deliveryStatus, 'for_rescheduling');
  assert.equal(f.order.paymentStatus, 'unpaid');
  assert.equal(f.order.visitAttempt.awaitingAdmin, true);
  assert.equal(f.events[0].route, '/admin/services/orders');
  assert.equal(f.events[1].route, '/customer/orders');
  assert.equal((await f.call('scheduleNextVisit', 'superadmin', { attemptId, scheduledDate: '2099-12-12', timeSlot: '10:00 AM – 12:00 PM' })).statusCode, 200);
  assert.equal(f.order.installationDate, '2099-12-12');
  assert.equal(f.order.installationTimeSlot, '10:00 AM – 12:00 PM');
  assert.equal(f.order.workflowStatus, 'to_dispatch');
  assert.equal(f.order.fulfillmentTimeline.length, 2);
  assert.equal(f.order.visitAttempt.awaitingAdmin, false);
  assert.equal(f.order.paymentStatus, 'unpaid');
  assert.ok(f.events.some(event => event.title === 'Installation revisit confirmed'));

  f.task().status = 'in-progress';
  f.task().payload.checkIn = { ...checkIn, checkedInAt: '2099-12-12T02:00:00.000Z' };
  const revisitInput = { ...input, checkedInAt: f.task().payload.checkIn.checkedInAt };
  assert.equal((await f.call('submitVisitAttempt', 'technician', revisitInput)).statusCode, 200);
  assert.equal(f.order.workflowStatus, 'to_dispatch');
  assert.equal(f.order.deliveryStatus, 'failed_installation');
  assert.equal(f.order.paymentStatus, 'unpaid');
});

test('failed installation records confirmed GCash and card payments as paid even when the legacy status is pending', async () => {
  for (const paymentMethod of ['gcash', 'card']) {
    const f = fixture({ delivery: true });
    f.order.paymentMethod = paymentMethod;
    f.order.paymentProvider = 'paymongo';
    f.order.paymentStatus = 'pending';
    f.order.totalAmount = 25000;
    f.order.paymongo = { paidAt: '2026-09-13T02:00:00.000Z', referenceNumber: `PAY-${paymentMethod}` };

    assert.equal((await f.call('submitVisitAttempt', 'technician')).statusCode, 200);
    assert.deepEqual(f.task().payload.visitAttempt.payment, {
      method: paymentMethod,
      provider: 'paymongo',
      status: 'paid',
      amount: 25000,
      paidAt: '2026-09-13T02:00:00.000Z',
      reference: `PAY-${paymentMethod}`,
    });
    assert.equal(f.order.workflowStatus, 'for_rescheduling');
    assert.equal(f.order.paymentStatus, 'pending');
  }
});
