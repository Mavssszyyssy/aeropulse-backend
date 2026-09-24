const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { login } = require('../src/controllers/authController');
const { changePassword } = require('../src/controllers/userController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('first-time setup must actually replace the initial password', async (t) => {
  const user = new User({ name_first: 'Test', name_last: 'Technician', role: 'technician', isFirstLogin: true });
  user.passwordHash = await bcrypt.hash('Initial123!', 4);
  const save = t.mock.method(user, 'save', async () => user);
  const res = response();
  await changePassword({ authUser: user, body: { newPassword: 'Initial123!' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /different/i);
  assert.equal(user.isFirstLogin, true);
  assert.equal(save.mock.callCount(), 0);
});

test('invalid or conflicting contact numbers cannot partly change a technician password', async (t) => {
  const user = new User({ name_first: 'Test', name_last: 'Technician', role: 'technician', isFirstLogin: true });
  user.passwordHash = await bcrypt.hash('Initial123!', 4);
  const originalHash = user.passwordHash;
  const save = t.mock.method(user, 'save', async () => user);
  const invalid = response();
  await changePassword({ authUser: user, body: { phone: '123', newPassword: 'Changed1#' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const find = t.mock.method(User, 'findOne', () => ({ select: async () => ({ _id: 'another-user' }) }));
  const conflict = response();
  await changePassword({ authUser: user, body: { phone: '09123456789', newPassword: 'Changed1#' } }, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(user.passwordHash, originalHash);
  assert.equal(user.isFirstLogin, true);
  assert.equal(save.mock.callCount(), 0);
  find.mock.mockImplementation(() => ({ select: async () => null }));
  const corrected = response();
  await changePassword({ authUser: user, body: { phone: '+639123456789', newPassword: 'Changed1#' } }, corrected);
  assert.equal(corrected.statusCode, 200);
  assert.equal(user.phone, '09123456789');
  assert.equal(user.isFirstLogin, false);
  assert.ok(await bcrypt.compare('Changed1#', user.passwordHash));
});

test('technician first password change completes setup and preserves the account TOTP challenge', async (t) => {
  const user = new User({ name_first: 'Test', name_last: 'Technician', role: 'technician', username: 'tech.cavite.test', isFirstLogin: true, security: { totpEnabled: true, totpResetRequired: true } });
  user.passwordHash = await bcrypt.hash('cavite.test', 4);
  user.phone = '09123456789';
  t.mock.method(User, 'findOne', () => ({ select: async () => null }));
  t.mock.method(user, 'save', async () => user);
  const res = response();
  await changePassword({ authUser: user, body: { newPassword: 'NewPass123#' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(user.isFirstLogin, false);
  assert.ok(user.technicianOnboardedAt);
  t.mock.method(User, 'findOne', async () => user);
  const signedIn = response();
  await login({ body: { identifier: user.username, password: 'NewPass123#' } }, signedIn);
  assert.equal(signedIn.body.requiresTotp, true);
  assert.equal(signedIn.body.token, undefined);
  const challenge = jwt.verify(signedIn.body.challengeToken, env.jwtSecret);
  assert.equal(challenge.purpose, 'login_totp');
  assert.equal(challenge.sub, user.id);
  const oldPassword = response();
  await login({ body: { identifier: user.username, password: 'cavite.test' } }, oldPassword);
  assert.equal(oldPassword.statusCode, 401);
});

test('account password rules accept punctuation and boundaries, reject missing criteria without changing the account', async (t) => {
  const user = new User({ name_first: 'Test', name_last: 'Technician', role: 'technician', isFirstLogin: true });
  const save = t.mock.method(user, 'save', async () => user);
  user.phone = '09123456789';
  t.mock.method(User, 'findOne', () => ({ select: async () => null }));
  for (const password of ['LongPassword123', 'onlylowercase!', 'A1!shor', 'UPPERCASE123!', 'NoNumbers!', 'Valid123! ', 'Valid123!\n', 'Valid123!\u0000', 'A'.repeat(23) + 'a1.', { value: 'Valid123!' }]) {
    const res = response();
    await changePassword({ authUser: user, body: { newPassword: password } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(user.isFirstLogin, true);
    assert.equal(save.mock.callCount(), 0);
  }
  for (const password of ['Abcdef1.', 'A'.repeat(22) + 'a1.', 'Valid123_', 'Valid123-', 'Valid123#']) {
    user.isFirstLogin = true;
    const res = response();
    await changePassword({ authUser: user, body: { newPassword: password } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(await bcrypt.compare(password, user.passwordHash));
  }
});

test('technician profile password change requires current password and persists a valid replacement', async (t) => {
  const user = new User({ name_first: 'Test', name_last: 'Technician', role: 'technician', isFirstLogin: false });
  user.passwordHash = await bcrypt.hash('OldPass123!', 4);
  t.mock.method(user, 'save', async () => user);
  const missing = response();
  await changePassword({ authUser: user, body: { newPassword: 'NewPass123!' } }, missing);
  assert.equal(missing.statusCode, 400);
  const wrong = response();
  await changePassword({ authUser: user, body: { currentPassword: 'wrong', newPassword: 'NewPass123!' } }, wrong);
  assert.equal(wrong.statusCode, 400);
  const reused = response();
  await changePassword({ authUser: user, body: { currentPassword: 'OldPass123!', newPassword: 'OldPass123!' } }, reused);
  assert.equal(reused.statusCode, 400);
  const valid = response();
  await changePassword({ authUser: user, body: { currentPassword: 'OldPass123!', newPassword: 'NewPass123!' } }, valid);
  assert.equal(valid.statusCode, 200);
  assert.ok(await bcrypt.compare('NewPass123!', user.passwordHash));
  t.mock.method(User, 'findOne', async () => user);
  const signedIn = response();
  await login({ body: { identifier: 'tech.fixture', password: 'NewPass123!' } }, signedIn);
  assert.ok(signedIn.body.token);
  const oldPassword = response();
  await login({ body: { identifier: 'tech.fixture', password: 'OldPass123!' } }, oldPassword);
  assert.equal(oldPassword.statusCode, 401);
});

test('every supported role requires its own enabled authenticator at sign-in', async (t) => {
  for (const role of ['customer', 'technician', 'admin', 'superadmin']) {
    const user = new User({ name_first: 'Test', name_last: 'User', role, security: { totpEnabled: true } });
    user.passwordHash = await bcrypt.hash('ValidPass123!', 4);
    t.mock.method(User, 'findOne', async () => user);
    const res = response();
    await login({ body: { identifier: 'test', password: 'ValidPass123!' } }, res);
    assert.equal(res.body.requiresTotp, true);
    assert.equal(res.body.token, undefined);
  }
});

test('required roles without an authenticator receive a restricted enrollment session', async (t) => {
  for (const role of ['customer', 'technician', 'admin', 'superadmin']) {
    const user = new User({ name_first: 'Enrollment', name_last: 'Required', role, security: { totpEnabled: false } });
    user.passwordHash = await bcrypt.hash('ValidPass123!', 4);
    t.mock.method(User, 'findOne', async () => user);
    t.mock.method(user, 'save', async () => user);
    const res = response();
    await login({ body: { identifier: `missing-totp-${role}`, password: 'ValidPass123!' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requiresTotpSetup, true);
    assert.ok(res.body.token);
    const token = jwt.verify(res.body.token, env.jwtSecret);
    assert.equal(token.sub, user.id);
    assert.equal(token.role, role);
  }
});
