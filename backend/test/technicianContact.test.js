const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const { changePassword, updateProfile } = require('../src/controllers/userController');
const { createStaff } = require('../src/controllers/staffController');
const { login, register } = require('../src/controllers/authController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('technician profile rejects invalid alias edits without changing the stored login', async (t) => {
  const user = new User({ name_first: 'Fixture', name_last: 'Tech', role: 'technician', alias: 'tech.fixture' });
  const save = t.mock.method(user, 'save', async () => user);
  for (const alias of ['', 'bad alias', 'x', 'a'.repeat(31)]) {
    const res = response();
    await updateProfile({ authUser: user, body: { alias } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(user.alias, 'tech.fixture');
  }
  assert.equal(save.mock.callCount(), 0);
});

test('technician alias cannot shadow another account username', async (t) => {
  const user = new User({ name_first: 'Fixture', name_last: 'Tech', role: 'technician', alias: 'tech.fixture' });
  t.mock.method(User, 'findOne', (query) => {
    assert.deepEqual(query.$or, [{ alias: 'taken.login' }, { username: 'taken.login' }]);
    return { select: async () => ({ _id: 'another-user' }) };
  });
  const save = t.mock.method(user, 'save', async () => user);
  const res = response();
  await updateProfile({ authUser: user, body: { alias: 'taken.login' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(user.alias, 'tech.fixture');
  assert.equal(save.mock.callCount(), 0);
});

test('shared phone parsing does not allow invalid customer identities or make phone mandatory at signup', async () => {
  for (const phone of ['abc09123456789', '091234567890', '+659123456789']) {
    const res = response();
    await register({ body: { name_first: 'Test', name_last: 'Customer', email: 'fixture@gmail.com', password: 'TestPass1#', phone } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /mobile number/);
  }
  for (const phone of ['', undefined, '09123456789', '+63 912 345 6789']) {
    const res = response();
    await register({ body: { name_first: 'Test', name_last: 'Customer', email: 'fixture@gmail.com', password: 'TestPass1#', phone } }, res);
    assert.equal(res.statusCode, 403); // passes optional-phone validation, still requires email verification
    assert.match(res.body.message, /Verify your email/);
  }
});

test('setup cannot bypass the required contact number', async (t) => {
  for (const phone of [undefined, '', ' ', 'abc09123456789', '091234567890']) {
    const user = new User({ name_first: 'Fixture', name_last: 'Tech', role: 'technician', isFirstLogin: true });
    const save = t.mock.method(user, 'save', async () => user);
    t.mock.method(User, 'findOne', () => ({ select: async () => null }));
    const res = response();
    await changePassword({ authUser: user, body: { newPassword: 'Changed1#', phone } }, res);
    assert.equal(res.statusCode, 400, `Rejected ${String(phone)}`);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(user.isFirstLogin, true);
    assert.equal(user.passwordHash, undefined);
  }
});

test('staff creation returns a useful conflict if another creation wins the unique-index race', async (t) => {
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(User, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { username: 1 } }); });
  const res = response();
  await createStaff({ authUser: { role: 'superadmin' }, body: { name_first: 'Fixture', name_last: 'Tech', loginName: 'fixture', role: 'technician', branch: 'Cavite', serviceQuota: 3 } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /username.*in use/i);
});

test('new technician accounts require a defined Service Quota', async () => {
  const res = response();
  await createStaff({ authUser: { role: 'superadmin' }, body: { name_first: 'Fixture', name_last: 'Tech', loginName: 'fixture', role: 'technician', branch: 'Cavite' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Service Quota is required/);
});

test('new technician accounts reject an oversized Service Quota', async () => {
  const res = response();
  await createStaff({ authUser: { role: 'superadmin' }, body: { name_first: 'Fixture', name_last: 'Tech', loginName: 'fixture', role: 'technician', branch: 'Cavite', serviceQuota: 51 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /from 1 to 50/);
});

test('valid technician creation assigns one branch and returns first-use credentials', async (t) => {
  t.mock.method(User, 'findOne', async () => null);
  let created;
  t.mock.method(User, 'create', async (data) => {
    created = data;
    return { ...data, toJSON() { return { username: data.username, role: data.role, assignedBranch: data.assignedBranch, serviceQuota: data.serviceQuota }; } };
  });
  const res = response();
  await createStaff({ authUser: { role: 'superadmin' }, body: {
    name_first: 'Fixture', name_last: 'Technician', loginName: 'fixture',
    role: 'technician', branch: 'Cavite', serviceQuota: 3,
  } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created.username, 'tech.cavite.fixture');
  assert.equal(created.assignedBranch, 'Cavite');
  assert.equal(created.activeBranch, 'Cavite');
  assert.equal(created.serviceQuota, 3);
  assert.equal(created.isFirstLogin, true);
  assert.equal(res.body.loginIdentifier, created.username);
  assert.notEqual(created.passwordHash, res.body.tempPassword);
});

test('phone save conflicts return a useful error rather than an internal server error', async (t) => {
  const user = new User({ name_first: 'Fixture', name_last: 'Tech', role: 'technician', isFirstLogin: true });
  t.mock.method(User, 'findOne', () => ({ select: async () => null }));
  t.mock.method(user, 'save', async () => { throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { phone: 1 } }); });
  const res = response();
  await changePassword({ authUser: user, body: { newPassword: 'Changed1#', phone: '09123456789' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /mobile number.*already exists/i);
});

test('phone sign-in uses the stored local format, without treating an alias as a phone number', async (t) => {
  const lookup = t.mock.method(User, 'findOne', async () => null);
  for (const identifier of ['09123456789', '+63 912 345 6789', '639123456789', '9123456789']) {
    await login({ body: { identifier, password: 'NotUsed1#' } }, response());
    assert.ok(lookup.mock.calls.at(-1).arguments[0].$or.some((clause) => clause.phone === '09123456789'));
  }
  await login({ body: { identifier: 'tech.cavite.person09123456789', password: 'NotUsed1#' } }, response());
  assert.ok(lookup.mock.calls.at(-1).arguments[0].$or.every((clause) => !clause.phone));
});

test('all supported phone formats complete setup with one canonical identity', async (t) => {
  for (const phone of ['09123456789', '9123456789', '639123456789', '+639123456789', '+63 912 345 6789', '0912-345-6789']) {
    const user = new User({ name_first: 'Fixture', name_last: 'Tech', role: 'technician', isFirstLogin: true });
    t.mock.method(user, 'save', async () => user);
    t.mock.method(User, 'findOne', () => ({ select: async () => null }));
    const res = response();
    await changePassword({ authUser: user, body: { newPassword: 'Changed1#', phone } }, res);
    assert.equal(res.statusCode, 200, phone);
    assert.equal(user.phone, '09123456789');
    assert.equal(user.isFirstLogin, false);
    assert.ok(user.technicianOnboardedAt);
  }
});
