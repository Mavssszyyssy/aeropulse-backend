const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { shouldActivateOrderTask } = require('../src/domain/orderTaskActivation');

test('dispatch and recovery activate the single linked technician task', () => {
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_deliver', deliveryStatus: 'preparing' }), false);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' }), true);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_dispatch', deliveryStatus: 'out_for_delivery' }), true);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_install', deliveryStatus: 'installing' }), true);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_dispatch', dispatchedAt: new Date() }), true);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_deliver' }, true), true);
});

test('assignment recovery does not bypass a closed unattended visit', () => {
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'for_rescheduling', deliveryStatus: 'for_rescheduling', dispatchedAt: new Date() }), false);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'to_dispatch', deliveryStatus: 'failed_installation', dispatchedAt: new Date() }), false);
  assert.equal(shouldActivateOrderTask({ workflowStatus: 'complete', deliveryStatus: 'completed' }), false);
});

const controllerSource = fs.readFileSync(require.resolve('../src/controllers/orderController'), 'utf8');
const taskFactoryStart = controllerSource.indexOf('const createTaskForOrder =');
const taskFactorySource = controllerSource.slice(taskFactoryStart, controllerSource.indexOf('\nconst findLinkedTaskForOrder =', taskFactoryStart));

function taskFactoryFixture(order, existingTask = null) {
  let created = 0;
  let saved = 0;
  const Task = class {
    constructor(fields) { Object.assign(this, fields); created += 1; }
    async save() { saved += 1; }
  };
  const createTaskForOrder = vm.runInNewContext(`${taskFactorySource}\ncreateTaskForOrder`, {
    shouldActivateOrderTask,
    findLinkedTaskForOrder: async () => existingTask,
    resolveTechnicianAssignment: async () => ({ assignedTechnicianId: 'tech-1', assignedTechnicianName: 'Assigned Technician' }),
    buildOrderTaskItems: () => [],
    buildOrderTaskAddress: () => 'Customer address',
    assertNoTaskScheduleConflict: async () => {},
    notifyAssignedTechnician: async () => {},
    Task,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  });
  return { createTaskForOrder: options => createTaskForOrder(order, options), created: () => created, saved: () => saved };
}

const sampleOrder = (overrides = {}) => ({
  id: 'order-1', orderCode: 'ORD-1', address: {}, customerName: 'Customer',
  stockSourceBranch: 'Bulacan', installationDate: '2099-10-17', installationTimeSlot: '9:00 AM - 12:00 PM',
  ...overrides,
});

test('repairing an existing task for a dispatched order activates the same task', async () => {
  const task = {
    _id: 'task-1', status: 'pending', assignedTechnicianId: 'tech-1',
    assignedTechnicianName: 'Assigned Technician', payload: {},
    scheduledDate: '2099-10-17', timeSlot: '9:00 AM - 12:00 PM',
    async save() { this.saveCount = (this.saveCount || 0) + 1; },
  };
  const fixture = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' }), task);
  assert.equal(await fixture.createTaskForOrder({ forceRefreshTask: true }), task);
  assert.equal(task.status, 'in-progress');
  assert.equal(task.payload.status, 'in-progress');
  assert.ok(task.payload.activatedAt);
  assert.equal(task.saveCount, 1);
  assert.equal(fixture.created(), 0);
});

test('repair creates an active task for a dispatched order but keeps pre-dispatch assignments pending', async () => {
  const dispatched = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' }));
  const activeTask = await dispatched.createTaskForOrder({ forceRefreshTask: true });
  assert.equal(activeTask.status, 'in-progress');
  assert.equal(dispatched.created(), 1);
  assert.equal(dispatched.saved(), 1);

  const preDispatch = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_deliver', deliveryStatus: 'preparing' }));
  const pendingTask = await preDispatch.createTaskForOrder({ forceRefreshTask: true });
  assert.equal(pendingTask.status, 'pending');
});

test('repair cannot activate a task awaiting visit follow-up', async () => {
  const task = { status: 'on-hold', payload: { visitAttempt: { awaitingAdmin: true } } };
  const fixture = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' }), task);
  await assert.rejects(fixture.createTaskForOrder({ forceRefreshTask: true }), /Use Visit follow-up/);
});

test('repair preserves installation in progress and rejects reassignment after arrival', async () => {
  const installing = {
    _id: 'task-1', status: 'installing', assignedTechnicianId: 'tech-1', payload: {},
    async save() { this.saveCount = (this.saveCount || 0) + 1; },
  };
  const activeFixture = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_install', deliveryStatus: 'installing' }), installing);
  await activeFixture.createTaskForOrder({ forceRefreshTask: true });
  assert.equal(installing.status, 'installing');

  const arrived = {
    _id: 'task-2', status: 'in-progress', assignedTechnicianId: 'tech-2',
    payload: { checkIn: { checkedInAt: '2099-10-17T09:00:00.000Z' } },
    async save() { this.saveCount = (this.saveCount || 0) + 1; },
  };
  const reassignment = taskFactoryFixture(sampleOrder({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched' }), arrived);
  await assert.rejects(reassignment.createTaskForOrder({ forceRefreshTask: true }), /already started the visit/);
  assert.equal(arrived.assignedTechnicianId, 'tech-2');
  assert.equal(arrived.saveCount, undefined);
});

const lifecycleStart = controllerSource.indexOf('const applyOrderLifecycleAction =');
const lifecycleSource = controllerSource.slice(lifecycleStart, controllerSource.indexOf('\nconst approveOrder =', lifecycleStart));

test('dispatch checks technician scheduling before saving the dispatched order', async () => {
  let saved = 0;
  const order = sampleOrder({ workflowStatus: 'to_deliver', deliveryStatus: 'preparing', async save() { saved += 1; } });
  const conflict = new Error('Technician schedule conflict');
  const applyOrderLifecycleAction = vm.runInNewContext(`${lifecycleSource}\napplyOrderLifecycleAction`, {
    lifecycleActions: { dispatch: { from: ['to_deliver'], to: 'to_dispatch', deliveryStatus: 'dispatched', status: 'paid' } },
    isCodOrder: () => false,
    findLinkedTaskForOrder: async () => ({ _id: 'task-1', status: 'pending', payload: {} }),
    resolveTechnicianAssignment: async () => ({ assignedTechnicianId: 'tech-1', assignedTechnicianName: 'Assigned Technician' }),
    assertNoTaskScheduleConflict: async () => { throw conflict; },
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  });
  await assert.rejects(applyOrderLifecycleAction(order, 'dispatch', { installationDate: '2099-10-17', timeSlot: '9:00 AM - 12:00 PM' }), error => error === conflict);
  assert.equal(order.workflowStatus, 'to_deliver');
  assert.equal(saved, 0);
});

const recoveryStart = controllerSource.indexOf('const recoverOrder =');
const recoverySource = controllerSource.slice(recoveryStart, controllerSource.indexOf('\n};', recoveryStart) + 3);

for (const action of ['recreate_task', 'assign_technician']) {
  test(`${action} synchronizes the order assignment with its repaired task`, async () => {
    let saved = 0;
    let response;
    const order = sampleOrder({ workflowStatus: 'to_dispatch', deliveryStatus: 'dispatched', async save() { saved += 1; } });
    const recoverOrder = vm.runInNewContext(`${recoverySource}\nrecoverOrder`, {
      getOrderForAdminAction: async () => order,
      findLinkedTaskForOrder: async () => null,
      resolveTechnicianAssignment: async () => ({ assignedTechnicianId: 'tech-1', assignedTechnicianName: 'Assigned Technician' }),
      createTaskForOrder: async () => ({ id: 'task-1', status: 'in-progress' }),
      hydrateOrdersWithInventoryQrCodes: async orders => orders,
    });
    await recoverOrder({ authUser: { role: 'admin' }, params: { orderId: 'order-1' }, body: {
      action, assignedTechnicianId: 'tech-1', installationDate: '2099-10-18', timeSlot: '1:00 PM - 4:00 PM',
    } }, { status() { return this; }, json(value) { response = value; return this; } });
    assert.equal(order.assignedTechnicianId, 'tech-1');
    assert.equal(order.assignedTechnician, 'Assigned Technician');
    assert.equal(order.installationDate, '2099-10-18');
    assert.equal(order.installationTimeSlot, '1:00 PM - 4:00 PM');
    assert.equal(saved, 1);
    assert.equal(response.task.id, 'task-1');
  });
}
