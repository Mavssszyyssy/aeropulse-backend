const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const User = require('../src/models/User');
const OtpRequest = require('../src/models/OtpRequest');
const auth = require('../src/controllers/authController');

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

for (const [name, action] of [['requestOtp', 'register_phone'], ['verifyOtp', 'register_phone'], ['requestPasswordReset', 'password_reset'], ['resetPasswordWithCode', 'password_reset']]) {
  test(`${name} rejects legacy SMS without reading or changing accounts`, async (t) => {
    const lookup = t.mock.method(User, 'findOne', () => { throw new Error('Must not query accounts'); });
    const otp = t.mock.method(OtpRequest, 'findOne', () => { throw new Error('Must not query OTPs'); });
    const res = response();
    await auth[name]({ body: { action, channel: 'sms', phone: '09123456789', identifier: '09123456789', code: '123456', newPassword: 'StrongPass1!' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(lookup.mock.callCount(), 0);
    assert.equal(otp.mock.callCount(), 0);
  });
}

test('a phone-only session or signed SMS proof cannot register a customer', async () => {
  const token = jwt.sign({ purpose: 'registration_verification', phone: '09123456789' }, env.jwtSecret);
  const res = response();
  await auth.register({ body: { email: 'customer@example.com', phone: '09123456789', password: 'StrongPass1!', registrationVerificationToken: token }, session: { registrationProgress: { formData: { phoneVerified: true, phone: '09123456789' } } } }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Verify your email/);
});

test('email OTP verification returns email-only proof and resumable progress', async (t) => {
  const code = '123456';
  t.mock.method(OtpRequest, 'findOne', (query) => {
    assert.equal(query.channel, 'email');
    assert.equal(query.email, 'customer@example.com');
    return { sort: async () => ({ codeHash: crypto.createHash('sha256').update(code).digest('hex'), expiresAt: new Date(Date.now() + 60_000), save: async () => {} }) };
  });
  const session = { registrationProgress: { formData: { phoneVerified: true } }, save: (callback) => callback() };
  const res = response();
  await auth.verifyOtp({ body: { action: 'register_email', channel: 'email', email: 'Customer@example.com', code }, session }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(session.registrationProgress.formData.emailVerified, true);
  assert.equal(session.registrationProgress.formData.phoneVerified, false);
  const proof = jwt.verify(res.body.registrationVerificationToken, env.jwtSecret);
  assert.equal(proof.email, 'customer@example.com');
  assert.equal(proof.phone, '');
});

test('email password recovery still accepts the registered email identifier', async (t) => {
  t.mock.method(User, 'findOne', async (query) => {
    assert.deepEqual(query, { $or: [{ alias: 'customer@example.com' }, { username: 'customer@example.com' }] });
    return null;
  });
  t.mock.method(User, 'find', (query) => {
    assert.deepEqual(query, { email: 'customer@example.com' });
    return { limit: async () => [] };
  });
  const res = response();
  await auth.requestPasswordReset({ body: { identifier: 'Customer@example.com' } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /If the account exists/);
});
