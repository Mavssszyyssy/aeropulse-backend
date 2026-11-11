const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SERVICE_QUOTA_REQUIRED_MESSAGE,
  normalizeServiceQuota,
  validateWarrantyAssignmentQuota,
} = require("../src/domain/technicianServiceQuota");

test("service quota accepts only whole numbers from 1 to 50", () => {
  assert.equal(normalizeServiceQuota(4), 4);
  assert.equal(normalizeServiceQuota("2"), 2);
  assert.equal(normalizeServiceQuota(50), 50);
  for (const value of [undefined, null, "", false, true, 0, -1, 1.5, 51, 10000000000, "not-a-number"]) {
    assert.equal(normalizeServiceQuota(value), null);
  }
});

test("warranty assignment requires a defined technician service quota", () => {
  const request = { payload: { warrantyClaimId: "claim-1" } };
  assert.equal(
    validateWarrantyAssignmentQuota({ request, technician: { serviceQuota: null } }),
    SERVICE_QUOTA_REQUIRED_MESSAGE,
  );
  assert.equal(validateWarrantyAssignmentQuota({ request, technician: { serviceQuota: 3 } }), "");
});

test("ordinary service assignment is unchanged when quota is undefined", () => {
  assert.equal(
    validateWarrantyAssignmentQuota({ request: { payload: {} }, technician: {} }),
    "",
  );
});
