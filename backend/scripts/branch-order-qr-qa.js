/* eslint-disable no-console */
// Creates synthetic records ONLY in the verified isolated localhost QA backend.
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { formatDateKeyInTimeZone } = require('../src/utils/dateTime');
const { BRANCHES } = require('../src/domain/branchRouting');
const zipRules = require('../src/utils/postalCodeRules.json');
const { closeIsolatedQaSession, createIsolatedQaSession } = require('./lib/isolatedQaSession');
const base = 'http://127.0.0.1:5002/api';
const database = process.env.ACCEPTANCE_EXPECTED_DATABASE;
if (!/^coldair_logic_\d{8}_e2e$/.test(database || '')) throw new Error('Explicit isolated QA database required');
const suffix = String(Date.now()).slice(-8);
const addresses = [
  'NCR|Metro Manila|Quezon City', 'CALABARZON|Cavite|Bacoor',
  'CALABARZON|Laguna|Cabuyao', 'Central Luzon|Bataan|Balanga',
  'Ilocos Region|Pangasinan|Dagupan', 'Ilocos Region|La Union|San Fernando',
].map((key) => {
  const [region, province, city] = key.split('|');
  assert.ok(zipRules[key]?.length, 'Use an address from the application ZIP rules');
  return { region, province, city, postalCode: zipRules[key][0].split('-')[0], barangay: 'QA District', street: 'Unit 1, Isolated Test Street', phone: `097${suffix}`, name: 'Branch QA Customer', label: 'QA delivery address', type: 'home', isDefault: true };
});
async function request(route, token, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${data.message || response.status}`);
  return data;
}
const login = createIsolatedQaSession;
const idOf = value => String(value.id || value._id);
const checkpoints = [];
function passed(name) { checkpoints.push(name); console.log(`PASS ${name}`); }

async function main() {
  const health = await request('/health');
  assert.equal(health.databaseName, database);
  assert.notEqual(health.environment, 'production');
  const owner = await login('superadmin.main', 'admin123');
  const admins = {};
  const techs = {};
  for (let i = 0; i < BRANCHES.length; i++) {
    const branch = BRANCHES[i];
    admins[branch] = await login(`admin.${branch.toLowerCase()}`, 'admin123');
    const staff = await request('/users/staff', owner.token, 'POST', { name_first: 'Branch QA', name_last: branch, role: 'technician', branch, loginName: `q${suffix}` }, 201);
    const initial = await login(staff.loginIdentifier, staff.tempPassword);
    await request('/users/password', initial.token, 'PATCH', { phone: `09${i}${suffix}`, newPassword: 'QaBranch1!' });
    techs[branch] = await login(staff.loginIdentifier, 'QaBranch1!');
  }
  const email = `branch.${suffix}@example.test`;
  let customer = await request('/auth/register', null, 'POST', {
    name_first: 'Branch QA', name_last: 'Customer', alias: `branch.${suffix}`, email, phone: addresses[0].phone,
    password: 'QaCustomer1!', municipality: addresses[0].city, submunicipality: addresses[0].barangay,
    contact_method: 'email', locations: [{ address: addresses[0], coordinates: {} }],
    registrationVerificationToken: jwt.sign({ purpose: 'registration_verification', email, phone: '' }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '5m' }),
  });
  await request('/users/profile', customer.token, 'PATCH', { customer_onboarded_at: new Date().toISOString() });
  assert.equal(customer.user.assignedBranch, 'Bulacan');
  passed('One customer account and six branch-specific admin/technician sessions');

  const created = await request('/products', owner.token, 'POST', { name: `Branch Cooling ${suffix}`, sku: `BR-${suffix}`, brand: 'Cold Air', category: 'split', specs: '2.5HP', price: 42000, threshold: 1, branchStock: Object.fromEntries(BRANCHES.map(b => [b, 3])) }, 201);
  const productId = idOf(created.product);
  async function product() {
    const catalog = await request('/products', owner.token);
    const found = catalog.products.find(p => idOf(p) === productId);
    assert.ok(found, 'Synthetic product must be visible in inventory');
    return found;
  }
  const checkout = async (address, product = productId) => (await request('/orders', customer.token, 'POST', { items: [{ productId: product, quantity: 1 }], address, paymentMethod: 'cod', platform: 'mobile' }, 201)).order;
  const assignment = branch => ({ assignedTechnicianId: idOf(techs[branch].user), installationDate: new Date(Date.now() + 2 * 86400000).toISOString(), timeSlot: '9:00 AM - 12:00 PM' });

  for (let i = 0; i < BRANCHES.length; i++) {
    const branch = BRANCHES[i];
    const admin = admins[branch]; const tech = techs[branch];
    const before = await product();
    let order = await checkout(addresses[i]); const orderId = idOf(order);
    assert.equal(order.customerBranch, branch);
    assert.equal(order.stockSourceBranch, branch);
    assert.equal(Number((await product()).branchStock[branch]), Number(before.branchStock[branch]));
    const alerts = await request('/notifications/me', admin.token);
    assert.ok(alerts.notifications.some(n => n.type === 'order' && String(n.targetId) === orderId));
    const wrongAdmin = admins[BRANCHES[(i + 1) % BRANCHES.length]];
    await request(`/orders/${orderId}/process`, wrongAdmin.token, 'PATCH', { action: 'dispatch', ...assignment(branch) }, 404);
    order = (await request(`/orders/${orderId}/process`, admin.token, 'PATCH', { action: 'dispatch', ...assignment(branch) })).order;
    assert.equal(order.tracking.currentStage, 'dispatched');
    const serial = order.items[0].serialNumbers[0]; assert.ok(serial);
    const storedLabel = order.items[0].serialUnits[0].qrCode;
    assert.match(storedLabel, /^QR_UNIT:/);
    const inventory = await product();
    assert.equal(Number(inventory.branchStock[branch]), Number(before.branchStock[branch]) - 1);
    for (const other of BRANCHES.filter(b => b !== branch)) assert.equal(inventory.branchStock[other], before.branchStock[other]);
    const physicalUnit = inventory.serialUnits.find(u => u.serialNumber === serial);
    assert.equal(physicalUnit.branch, branch); assert.equal(physicalUnit.status, 'assigned');
    const taskList = await request('/tasks', tech.token);
    const task = taskList.tasks.find(t => String(t.payload?.orderId || t.orderId) === orderId); assert.ok(task);
    const taskId = idOf(task); assert.equal(task.branch, branch);
    const wrongTech = techs[BRANCHES[(i + 1) % BRANCHES.length]];
    await request(`/tasks/${taskId}`, wrongTech.token, 'GET', undefined, 404);
    const qrId = storedLabel.split('|')[0].slice('QR_UNIT:'.length);
    const resolved = await request(`/products/serial/${encodeURIComponent(qrId)}`, tech.token);
    assert.equal(resolved.unit.serialNumber, serial);
    const required = task.payload?.serialNumbers || task.serialNumbers;
    assert.ok(required.includes(resolved.unit.serialNumber));
    const registration = { serialNumber: serial, installationDate: formatDateKeyInTimeZone(new Date()), installationTime: '00:00', roomSizeSqm: 30, registrationSource: 'qr_scan' };
    await request(`/tasks/${taskId}/amp-registration`, tech.token, 'PATCH', registration, 409);
    await request(`/tasks/${taskId}/check-in`, tech.token, 'PATCH', { coordinates: { latitude: 14.65 + i / 10, longitude: 121.02, accuracy: 8 } });
    const arrival = await request(`/orders/me/${orderId}`, customer.token);
    assert.equal(arrival.order.tracking.currentStage, 'arrived');
    const adminTask = await request(`/tasks/${taskId}`, admin.token);
    assert.ok(adminTask.task.payload.checkIn.checkedInAt);
    await request(`/tasks/${taskId}/cod-collection`, tech.token, 'PATCH', { confirmed: true });
    const foreignSerial = inventory.serialUnits.find(u => u.branch !== branch).serialNumber;
    await request(`/tasks/${taskId}/amp-registration`, tech.token, 'PATCH', { ...registration, serialNumber: foreignSerial }, 400);
    await request(`/tasks/${taskId}/amp-registration`, tech.token, 'PATCH', registration);
    await request(`/tasks/${taskId}/status`, tech.token, 'PATCH', { status: 'completed', proof: { afterPhotos: [{ uri: 'data:image/jpeg;base64,cWEtcHJvb2Y=', label: 'Synthetic QA installation proof' }] } });
    const final = await request(`/orders/me/${orderId}`, customer.token);
    assert.equal(final.order.workflowStatus, 'complete'); assert.equal(final.order.paymentStatus, 'paid');
    const units = await request('/amp/customer/units', customer.token);
    const unit = units.units.find(u => u.serialNumber === serial); assert.ok(unit);
    assert.equal(unit.warrantyStatus, 'active'); assert.equal(unit.capacityHp, 2.5);
    await request(`/orders/${orderId}/recovery`, admin.token, 'PATCH', { action: 'recreate_task', ...assignment(branch) }, 409);
    passed(`${branch}: same-customer checkout → correct admin alert → dispatch → branch inventory QR → assigned technician → GPS/COD → installation → My Units/warranty`);

    const cancelled = await checkout(addresses[i]);
    const cancelledId = idOf(cancelled);
    const assigned = await request(`/orders/${cancelledId}/recovery`, admin.token, 'PATCH', { action: 'assign_technician', ...assignment(branch) });
    const cancelledTaskId = idOf(assigned.task);
    const stockBeforeCancel = (await product()).branchStock;
    await request(`/orders/${cancelledId}/process`, admin.token, 'PATCH', { action: 'cancel', cancellationReason: 'Isolated QA cancellation regression' });
    const stopped = await request(`/tasks/${cancelledTaskId}`, tech.token);
    assert.equal(stopped.task.status, 'cancelled');
    assert.equal(stopped.task.payload.cancelledByOrder, true);
    await request(`/tasks/${cancelledTaskId}/check-in`, tech.token, 'PATCH', { coordinates: { latitude: 14.65, longitude: 121.02, accuracy: 8 } }, 409);
    for (const action of ['recreate_task', 'assign_technician', 'sync_installed_units']) {
      await request(`/orders/${cancelledId}/recovery`, admin.token, 'PATCH', { action, ...assignment(branch) }, 409);
    }
    assert.deepEqual((await product()).branchStock, stockBeforeCancel);
    passed(`${branch}: cancellation closes linked task; GPS/recovery cannot revive it; stock unchanged`);
  }
  // A real nearby-stock case differs from changing the delivery address.
  const fallbackProduct = (await request('/products', owner.token, 'POST', { name: `Nearby Cooling ${suffix}`, sku: `NEAR-${suffix}`, brand: 'Cold Air', category: 'split', specs: '1.0HP', price: 22000, branchStock: { Cavite: 1 } }, 201)).product;
  const nearbyOrder = await checkout(addresses[0], idOf(fallbackProduct));
  assert.equal(nearbyOrder.customerBranch, 'Bulacan'); assert.equal(nearbyOrder.stockSourceBranch, 'Cavite');
  const nearbyId = idOf(nearbyOrder);
  for (const branch of ['Bulacan', 'Cavite']) {
    const alerts = await request('/notifications/me', admins[branch].token);
    assert.ok(alerts.notifications.some(n => n.type === 'order' && String(n.targetId) === nearbyId));
  }
  await request(`/orders/${nearbyId}/process`, admins.Cavite.token, 'PATCH', { action: 'dispatch', ...assignment('Bulacan') }, 409);
  const nearbyDispatch = await request(`/orders/${nearbyId}/process`, admins.Cavite.token, 'PATCH', { action: 'dispatch', ...assignment('Cavite') });
  const nearbySerial = nearbyDispatch.order.items[0].serialNumbers[0];
  const nearbyTasks = await request('/tasks', techs.Cavite.token);
  const nearbyTask = nearbyTasks.tasks.find(t => String(t.payload?.orderId || t.orderId) === nearbyId); assert.ok(nearbyTask);
  const nearbyQr = nearbyDispatch.order.items[0].serialUnits[0].qrCode.split('|')[0].slice(8);
  assert.equal((await request(`/products/serial/${encodeURIComponent(nearbyQr)}`, techs.Cavite.token)).unit.serialNumber, nearbySerial);
  passed('Nearby-stock order: Bulacan delivery uses Cavite stock/technician; both admins notified; correct QR resolves');
  console.log(`Completed ${checkpoints.length} branch-flow checkpoints in isolated QA only. No live purchases, messages, or payments.`);
}
main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(closeIsolatedQaSession);
