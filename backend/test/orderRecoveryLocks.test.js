const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/controllers/orderController'), 'utf8');
const start = source.indexOf('const recoverOrder =');
const recoverSource = source.slice(start, source.indexOf('\n};', start) + 3);

for (const action of ['recreate_task', 'assign_technician', 'sync_installed_units']) {
  test(`cancelled order cannot be revived through ${action}`, async () => {
    let status, response;
    const recover = vm.runInNewContext(`${recoverSource}; recoverOrder`, {
      getOrderForAdminAction: async () => ({ workflowStatus: 'cancelled' }),
    });
    await recover({ authUser: { role: 'superadmin' }, params: { orderId: 'fixture' }, body: { action } }, {
      status(value) { status = value; return this; }, json(value) { response = value; return this; },
    });
    assert.equal(status, 409);
    assert.match(response.message, /cancelled orders are locked/i);
  });
}

test('completed order does not recreate or reassign technician work', async () => {
  let status;
  const recover = vm.runInNewContext(`${recoverSource}; recoverOrder`, {
    getOrderForAdminAction: async () => ({ workflowStatus: 'complete' }),
  });
  await recover({ authUser: { role: 'admin' }, params: { orderId: 'fixture' }, body: { action: 'recreate_task' } }, {
    status(value) { status = value; return this; }, json() { return this; },
  });
  assert.equal(status, 409);
});

test('assignment conflict does not partially save the order', async () => {
  let saveCount = 0;
  const conflict = Object.assign(new Error('Technician schedule conflict'), {
    status: 409,
    statusCode: 409,
  });
  const order = {
    id: 'order-fixture',
    orderCode: 'ORD-FIXTURE',
    workflowStatus: 'paid',
    stockSourceBranch: 'Bulacan',
    customerBranch: 'Bulacan',
    assignedTechnician: '',
    installationDate: '2099-10-01',
    installationTimeSlot: '9:00 AM - 12:00 PM',
    async save() { saveCount += 1; },
  };
  const recover = vm.runInNewContext(`${recoverSource}; recoverOrder`, {
    getOrderForAdminAction: async () => order,
    findLinkedTaskForOrder: async () => null,
    resolveTechnicianAssignment: async () => ({
      assignedTechnicianId: 'technician-fixture',
      assignedTechnicianName: 'Available Technician',
    }),
    createTaskForOrder: async () => { throw conflict; },
  });

  await assert.rejects(
    recover({
      authUser: { role: 'admin' },
      params: { orderId: order.id },
      body: {
        action: 'assign_technician',
        assignedTechnicianId: 'technician-fixture',
        installationDate: '2099-10-01',
        timeSlot: '9:00 AM - 12:00 PM',
      },
    }, {
      status() { return this; },
      json() { return this; },
    }),
    (error) => error === conflict,
  );
  assert.equal(saveCount, 0);
});

test('cancel propagation only closes non-terminal linked work and leaves other fields intact', async () => {
  const blockStart = source.indexOf('await Task.updateMany(', source.indexOf('const applyOrderLifecycleAction'));
  const block = source.slice(blockStart, source.indexOf('\n    );', blockStart) + 7);
  let query, update;
  await vm.runInNewContext(`(async () => { ${block} })()`, {
    Task: { updateMany: async (q, u) => { query = q; update = u; } },
    order: { _id: 'order1', orderCode: 'ORDER-FIXTURE' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(query)), {
    status: { $nin: ['completed', 'cancelled'] },
    $or: [{ 'payload.orderId': 'order1' }, { 'payload.orderCode': 'ORDER-FIXTURE' }],
  });
  assert.equal(update.$set.status, 'cancelled');
  assert.equal(update.$set['payload.status'], 'cancelled');
  assert.equal(update.$set['payload.cancelledByOrder'], true);
  assert.deepEqual(Object.keys(update.$set).sort(), ['payload.cancelledByOrder', 'payload.status', 'payload.updatedAt', 'status']);
});

test('keyless purchases get distinct keys while explicit checkout retry keys are preserved', () => {
  const expression = source.match(/idempotencyKey: (idempotencyKey \|\| `server:\$\{crypto\.randomUUID\(\)\}`)/)?.[1];
  assert.ok(expression, 'Order creation must not omit the indexed key');
  const createKey = key => vm.runInNewContext(expression, { idempotencyKey: key, crypto: require('node:crypto') });
  assert.notEqual(createKey(''), createKey(''));
  assert.equal(createKey('checkout-retry-fixture'), 'checkout-retry-fixture');
});
