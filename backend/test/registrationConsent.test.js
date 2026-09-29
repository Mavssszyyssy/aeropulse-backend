const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const User = require('../src/models/User');
const OtpRequest = require('../src/models/OtpRequest');
const auth = require('../src/controllers/authController');
const { LEGAL_VERSION, validateRegistrationConsent } = require('../src/domain/registrationConsent');
const agreed = { version: LEGAL_VERSION, app: true, service: true, warranty: true, privacy: true };
const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const body = legalConsent => ({ name_first: 'QA', name_last: 'Customer', email: 'legal@gmail.com', password: 'TestPass1!', legalConsent, registrationVerificationToken: jwt.sign({ purpose: 'registration_verification', email: 'legal@gmail.com' }, env.jwtSecret) });
test('current, explicit consent is required; missing, stale and truthy strings fail', () => {
  assert.equal(validateRegistrationConsent(agreed), '');
  for (const value of [undefined, {}, {...agreed, version:'old'}, ...['app','service','warranty','privacy'].flatMap(key => [ {...agreed,[key]:false}, {...agreed,[key]:'true'} ])]) assert.ok(validateRegistrationConsent(value));
});
test('verified email does not bypass legal acceptance or create an account', async t => {
  const create = t.mock.method(User, 'create', async () => { throw new Error('Must not create'); });
  const res=response(); await auth.register({body:body(undefined)},res);
  assert.equal(res.statusCode,400); assert.match(res.body.message,/Terms/); assert.equal(create.mock.callCount(),0);
});
test('registration persists server-stamped acceptance, ignoring forged timestamps', async t => {
  let saved;
  t.mock.method(User, 'create', async data => { saved=new User(data); await saved.validate(); return saved; });
  t.mock.method(OtpRequest, 'deleteMany', async () => ({}));
  const start=Date.now();const res=response();
  await auth.register({body:body({...agreed,acceptedAt:'1999-01-01'})},res);
  assert.equal(res.statusCode,200); assert.equal(res.body.success,true);
  assert.equal(saved.legalConsent.version,LEGAL_VERSION); assert.ok(saved.legalConsent.acceptedAt.getTime()>=start);
  assert.equal(saved.role,'customer');
  assert.equal(new User({}).legalConsent,undefined); // No invented acceptance for older accounts.
});
test('offline mobile policies match web documents verbatim', () => {
  const root=path.join(__dirname,'../..');
  const web=fs.readFileSync(path.join(root,'front/src/domain/legalPolicies.js'),'utf8');
  const canonical=Function(web.replace(/export /g,'')+';return {lastUpdated:LEGAL_LAST_UPDATED,policies:LEGAL_POLICIES};')();
  const mobile=JSON.parse(fs.readFileSync(path.join(root,'bork5/caact-mobile/constants/legalPolicies.json'),'utf8'));
  assert.deepEqual(mobile,canonical);
  assert.equal(new Date(mobile.lastUpdated+' 00:00:00 UTC').toISOString().slice(0,10),LEGAL_VERSION);
});
