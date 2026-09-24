// Only creates synthetic technicians in the explicitly isolated local QA API.
const assert = require('node:assert/strict');
const { closeIsolatedQaSession, createIsolatedQaSession } = require('./lib/isolatedQaSession');
const base = 'http://127.0.0.1:5002/api';
const database = process.env.ACCEPTANCE_EXPECTED_DATABASE;
if (!/^coldair_logic_\d{8}_e2e$/.test(database || '')) throw new Error('Set the isolated QA database name first.');
let passed = 0;
async function request(path, token, method = 'GET', body, status = 200) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  assert.equal(res.status, status, `${method} ${path}: ${data.message || res.status}`);
  return data;
}
const check = (name) => { passed++; console.log(`PASS ${name}`); };
async function main() {
  const health = await request('/health');
  assert.equal(health.databaseName, database);
  assert.notEqual(health.environment, 'production');
  const owner = await createIsolatedQaSession('superadmin.main', 'admin123');
  assert.ok(owner.token);
  check('isolated database and owner session');
  const suffix = String(Date.now()).slice(-8);
  const phone = `091${suffix}`;
  const draft = { name_first: 'Contact', name_last: 'QA', role: 'technician', branch: 'Cavite', loginName: `p${suffix}` };
  const staff = await request('/users/staff', owner.token, 'POST', draft, 201);
  assert.equal(staff.loginIdentifier, `tech.cavite.p${suffix}`);
  assert.equal(staff.tempPassword, `cavite.p${suffix}`);
  check('branch-based technician creation');
  await request('/users/staff', owner.token, 'POST', draft, 409);
  check('duplicate creation is rejected');
  let tech = await createIsolatedQaSession(staff.loginIdentifier, staff.tempPassword);
  assert.ok(tech.token);
  assert.equal(tech.user.isFirstLogin, true);
  await request('/tasks', tech.token, 'GET', undefined, 403);
  await request('/users/password', tech.token, 'PATCH', { newPassword: 'QaContact1#' }, 400);
  await request('/users/password', tech.token, 'PATCH', { newPassword: 'QaContact1#', phone: phone + '0' }, 400);
  const incomplete = await request('/auth/me', tech.token);
  assert.equal(incomplete.user.isFirstLogin, true);
  check('incomplete setup cannot access work or silently finish');
  const formatted = `+63 ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`;
  const completed = await request('/users/password', tech.token, 'PATCH', { newPassword: 'QaContact1#', phone: formatted });
  assert.equal(completed.user.phone, phone);
  assert.equal(completed.user.isFirstLogin, false);
  assert.ok(completed.user.technicianOnboardedAt);
  check('formatted international number completes setup');
  await assert.rejects(
    createIsolatedQaSession(staff.loginIdentifier, staff.tempPassword),
    (error) => error.status === 401,
  );
  for (const identifier of [staff.loginIdentifier, phone, phone.slice(1), `63${phone.slice(1)}`, formatted]) {
    tech = await createIsolatedQaSession(identifier, 'QaContact1#');
    assert.ok(tech.token);
  }
  check('new password and all supported phone sign-in formats work; initial password fails');
  await request('/tasks', tech.token);
  const roster = await request('/users?role=technician', owner.token);
  assert.ok(roster.users.some((user) => user.id === completed.user.id && user.phone === phone && user.assignedBranch === 'Cavite'));
  check('completed technician can access work and appears in staff roster');
  const duplicate = await request('/users/staff', owner.token, 'POST', { ...draft, loginName: `q${suffix}` }, 201);
  let other = await createIsolatedQaSession(duplicate.loginIdentifier, duplicate.tempPassword);
  await request('/users/password', other.token, 'PATCH', { newPassword: 'QaContact1#', phone: formatted }, 409);
  other = await createIsolatedQaSession(duplicate.loginIdentifier, duplicate.tempPassword);
  assert.equal(other.user.isFirstLogin, true);
  check('duplicate phone leaves the second account and initial password unchanged');
  await request('/users/profile', tech.token, 'PATCH', { phone: `63${phone.slice(1)}` });
  await request('/users/password', tech.token, 'PATCH', { currentPassword: 'QaContact1#', newPassword: 'QaContact2#' });
  const renewed = await createIsolatedQaSession(staff.loginIdentifier, 'QaContact2#');
  assert.ok(renewed.token);
  await assert.rejects(
    createIsolatedQaSession(staff.loginIdentifier, 'QaContact1#'),
    (error) => error.status === 401,
  );
  check('profile contact and later password update work');
  console.log(`${passed} checkpoints passed. Synthetic accounts retained only in ${database}.`);
}
main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(closeIsolatedQaSession);
