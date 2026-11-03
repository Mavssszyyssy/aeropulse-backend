const test = require("node:test");
const assert = require("node:assert/strict");
const users = require("../src/controllers/userController");
const services = require("../src/controllers/serviceRequestController");
const warranty = require("../src/controllers/warrantyController");
const Unit = require("../src/models/Unit");

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const validAddress = {
  name: "Maria Santos", phone: "09123456789", street: "Lot 1 Main Street",
  barangay: "Bago Bantay", city: "Quezon City", province: "Metro Manila",
  region: "NCR", postalCode: "1105",
};

test("customer service concern over 500 characters is rejected before persistence", async () => {
  const res = response();
  await services.createMyServiceRequest({
    body: { customerName: "Maria Santos", issueDescription: "x".repeat(501), address: "Lot 1 Main Street", serviceId: "repair" },
    get: () => "", authUser: { name: "Maria Santos" },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /500 characters/);
});

test("warranty concern uses the same 500-character limit", async (t) => {
  t.mock.method(Unit, "findById", async () => ({ _id: "unit-1", customer: "customer-1", warranty: { claims: [] } }));
  const res = response();
  await warranty.createWarrantyClaim({
    params: { unitId: "unit-1" }, authUser: { _id: "customer-1", role: "customer" },
    body: { issue: "x".repeat(501) },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /500 characters/);
});

test("an invalid address recipient is rejected before persistence", async () => {
  const res = response();
  await users.addAddress({ body: { ...validAddress, name: "12345" }, authUser: { addresses: [] } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.errors.name);
});

test("a ninth delivery address is rejected without changing existing addresses", async () => {
  const saved = Array.from({ length: 8 }, (_, index) => ({ ...validAddress, label: `Address ${index + 1}` }));
  const user = { addresses: saved, save: async () => { throw new Error("must not save"); } };
  const res = response();
  await users.addAddress({ body: validAddress, authUser: user }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(user.addresses, saved);
  assert.match(res.body.message, /up to 8/);
});

test("customer profile rejects an empty or malformed username", async () => {
  for (const alias of ["", "bad name", "x"]) {
    const user = { role: "customer", addresses: [], save: async () => { throw new Error("must not save"); } };
    const res = response();
    await users.updateProfile({ authUser: user, body: { alias } }, res);
    assert.equal(res.statusCode, 400, alias);
    assert.match(res.body.message, /Username must be/);
  }
});

test("invalid profile edits leave existing names unchanged", async () => {
  const user = { role: "customer", name_first: "Maria", name_last: "Santos", addresses: [], save: async () => { throw new Error("must not save"); } };
  const res = response();
  await users.updateProfile({ authUser: user, body: { name_first: "Anna", name_last: "12345", alias: "anna.santos" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(user.name_first, "Maria");
  assert.equal(user.name_last, "Santos");
});
