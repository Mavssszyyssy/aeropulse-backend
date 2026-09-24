const test = require("node:test");
const assert = require("node:assert/strict");
const { containsProtectedAdminFields } = require("../src/domain/adminSettingsPolicy");
const { updateProfile, updateSettings } = require("../src/controllers/userController");

const responseRecorder = () => {
  let statusCode = 200;
  let body = null;
  return {
    res: {
      status(code) { statusCode = code; return this; },
      json(value) { body = value; return value; },
    },
    result: () => ({ statusCode, body }),
  };
};

test("admin settings policy rejects protected company, branch, role and permission fields", () => {
  [
    { storeName: "Changed" },
    { address: "Another branch" },
    { assignedBranch: "Bulacan" },
    { activeBranch: "Bulacan" },
    { role: "superadmin" },
    { permissions: ["all"] },
    { roles: { adminMode: "full" } },
    { general: { storeName: "Changed" } },
    { general: { address: "Another branch" } },
  ].forEach((payload) => assert.equal(containsProtectedAdminFields(payload), true));
});

test("admin settings policy allows only persisted preference and notification fields", () => {
  assert.equal(containsProtectedAdminFields({
    preferences: { currency: "PHP" },
    notifications: { email: true, inApp: true, push: false },
  }), false);
});

test("admin settings endpoint rejects a crafted protected-field update before saving", async () => {
  let saved = false;
  const response = responseRecorder();
  const req = {
    body: { assignedBranch: "Bulacan", role: "superadmin" },
    authUser: {
      role: "admin",
      save: async () => { saved = true; },
    },
  };
  await updateSettings(req, response.res);

  assert.equal(response.result().statusCode, 403);
  assert.equal(saved, false);
  assert.match(response.result().body.message, /read-only/i);
});

test("admin profile endpoint also rejects branch and authority escalation fields", async () => {
  let saved = false;
  const response = responseRecorder();
  await updateProfile({
    body: { activeBranch: "Bulacan", permissions: ["company-wide"] },
    authUser: {
      role: "admin",
      save: async () => { saved = true; },
    },
  }, response.res);

  assert.equal(response.result().statusCode, 403);
  assert.equal(saved, false);
  assert.match(response.result().body.message, /SuperAdmin/i);
});
