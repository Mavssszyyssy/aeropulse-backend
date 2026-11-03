const test = require('node:test');
const assert = require('node:assert/strict');
const BranchCoverage = require('../src/models/BranchCoverage');
const Product = require('../src/models/Product');
const AuditLog = require('../src/models/AuditLog');
const User = require('../src/models/User');
const branchRoutes = require('../src/routes/branchCoverageRoutes');
const { BRANCHES, setConfiguredBranches } = require('../src/domain/branchRouting');
const { clearBranchCoverageCache } = require('../src/services/branchCoverageService');
const { createBranchCoverage } = require('../src/controllers/branchCoverageController');
const { archiveProduct, restoreProduct, listStockStatus } = require('../src/controllers/productController');

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('only Superadmin is authorized by the branch creation route', () => {
  const route = branchRoutes.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route;
  const roleGate = route.stack[1].handle;
  const denied = response();
  roleGate({ authUser: { role: 'admin' } }, denied, () => assert.fail('Admin must not pass'));
  assert.equal(denied.statusCode, 403);
  let allowed = false;
  roleGate({ authUser: { role: 'superadmin' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
});

test('new branch is stored once, leaves existing branches untouched, and becomes selectable', async (t) => {
  const original = [...BRANCHES];
  t.after(() => { setConfiguredBranches(original); clearBranchCoverageCache(); });
  let saved;
  t.mock.method(BranchCoverage, 'exists', async () => false);
  t.mock.method(BranchCoverage, 'bulkWrite', async () => ({}));
  t.mock.method(BranchCoverage, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return original.map((name) => ({ name, active: true, coverageAreas: [name.toLowerCase()], nearbyBranches: [] })); } }));
  t.mock.method(BranchCoverage, 'create', async (data) => { saved = data; return data; });
  clearBranchCoverageCache();
  const res = response();
  await createBranchCoverage({ body: { name: '  Pampanga  ', coverageAreas: 'Angeles, San Fernando' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(saved.name, 'Pampanga');
  assert.deepEqual(saved.coverageAreas, ['angeles', 'san fernando']);
  assert.deepEqual(BRANCHES.slice(0, original.length), original);
  assert.equal(BRANCHES.includes('Pampanga'), true);
});

test('duplicate name or overlapping service area is rejected before writing', async (t) => {
  const original = [...BRANCHES];
  t.after(() => { setConfiguredBranches(original); clearBranchCoverageCache(); });
  let creates = 0;
  t.mock.method(BranchCoverage, 'exists', async ({ name }) => name.test('Bulacan'));
  t.mock.method(BranchCoverage, 'create', async () => { creates += 1; });
  const duplicate = response();
  await createBranchCoverage({ body: { name: 'bulacan', coverageAreas: 'new place' } }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(creates, 0);
  const unsafeMapKey = response();
  await createBranchCoverage({ body: { name: 'St. City', coverageAreas: 'New place' } }, unsafeMapKey);
  assert.equal(unsafeMapKey.statusCode, 400);
  t.mock.method(BranchCoverage, 'bulkWrite', async () => ({}));
  t.mock.method(BranchCoverage, 'find', () => ({ select() { return this; }, sort() { return this; }, async lean() { return [{ name: 'Bulacan', active: true, coverageAreas: ['malolos'], nearbyBranches: [] }]; } }));
  clearBranchCoverageCache();
  const conflict = response();
  await createBranchCoverage({ body: { name: 'Pampanga', coverageAreas: 'Malolos' } }, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(creates, 0);
});

test('archive and restore retain stock and historical references', async (t) => {
  const id = '507f1f77bcf86cd799439011';
  const product = { _id: id, name: 'AC', stock: 4, serialUnits: [{ serialNumber: 'S1' }], isActive: true, saves: 0,
    async save() { this.saves += 1; }, toJSON() { return { id, isActive: this.isActive, stock: this.stock }; } };
  t.mock.method(Product, 'findById', async () => product);
  t.mock.method(AuditLog, 'create', async () => ({}));
  const req = { params: { productId: id }, authUser: { role: 'superadmin', _id: id } };
  const archived = response();
  await archiveProduct(req, archived);
  assert.equal(archived.body.archived, true);
  assert.equal(product.isActive, false);
  assert.equal(product.stock, 4);
  assert.equal(product.serialUnits.length, 1);
  const restored = response();
  await restoreProduct(req, restored);
  assert.equal(restored.body.archived, false);
  assert.equal(product.isActive, true);
  assert.equal(product.saves, 2);
  const denied = response();
  await archiveProduct({ ...req, authUser: { role: 'admin' } }, denied);
  assert.equal(denied.statusCode, 403);
});

test('stock status uses a minimal current branch inventory snapshot without serial data', async (t) => {
  let selection;
  t.mock.method(Product, 'find', (filter) => {
    assert.deepEqual(filter, { isActive: { $ne: false } });
    return { select(fields) { selection = fields; return this; }, async lean() { return [
      { _id: 'product-1', name: 'AC', sku: 'AC-1', brand: 'Cold Air', threshold: 2, branchThresholds: { Bulacan: 3 }, branchStock: { Bulacan: 2, Cavite: 0 }, serialUnits: [{ serialNumber: 'private' }] },
      { _id: 'product-2', name: 'QA Sample', sku: 'QA-1', brand: 'Test', branchStock: { Bulacan: 0 } },
    ]; } };
  });
  const superResponse = { ...response(), set() {} };
  await listStockStatus({ authUser: { role: 'superadmin' } }, superResponse);
  assert.equal(selection.includes('serialUnits'), false);
  assert.equal(superResponse.body.products.length, 1);
  assert.deepEqual(superResponse.body.products[0].branchStock, { Bulacan: 2, Cavite: 0 });
  const adminResponse = { ...response(), set() {} };
  await listStockStatus({ authUser: { role: 'admin' }, activeBranch: 'Cavite' }, adminResponse);
  assert.deepEqual(adminResponse.body.products[0].branchStock, { Cavite: 0 });
  assert.deepEqual(adminResponse.body.products[0].branchThresholds, {});
});

test('authorized administrator onboarding hashes credentials and blocks duplicate email', async (t) => {
  const emailPolicy = require('../src/services/emailDomainPolicyService');
  const email = require('../src/utils/email');
  t.mock.method(emailPolicy, 'validateEmailAddress', async () => ({ ok: true }));
  t.mock.method(email, 'canSendEmail', () => false);
  // Staff imports these helpers by value, so load it after the isolated mocks.
  const staffPath = require.resolve('../src/controllers/staffController');
  delete require.cache[staffPath];
  const { createStaff } = require('../src/controllers/staffController');
  t.after(() => { delete require.cache[staffPath]; });
  t.mock.method(User, 'exists', async () => false);
  t.mock.method(User, 'findOne', async () => null);
  let saved;
  t.mock.method(User, 'create', async (data) => { saved = data; return { ...data, toJSON() { return { role: data.role, assignedBranch: data.assignedBranch, email: data.email }; } }; });
  const request = { authUser: { role: 'superadmin' }, body: { role: 'admin', branch: 'Bulacan', name_first: 'Ana', name_last: 'Cruz', email: 'Ana@example.com' } };
  const res = response();
  await createStaff(request, res);
  assert.equal(res.statusCode, 201);
  assert.equal(saved.role, 'admin');
  assert.equal(saved.assignedBranch, 'Bulacan');
  assert.equal(saved.isFirstLogin, true);
  assert.notEqual(saved.passwordHash, res.body.tempPassword);
  assert.equal(saved.email, 'ana@example.com');
  const denied = response();
  await createStaff({ ...request, authUser: { role: 'admin' } }, denied);
  assert.equal(denied.statusCode, 403);
  User.findOne.mock.mockImplementation(async () => ({ _id: 'existing' }));
  const duplicate = response();
  await createStaff(request, duplicate);
  assert.equal(duplicate.statusCode, 409);
});
