const test = require("node:test");
const assert = require("node:assert/strict");
const { containsProtectedAdminFields } = require("../src/domain/adminSettingsPolicy");
const { updateProfile, updateSettings, updatePreferences } = require("../src/controllers/userController");

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
    { general: { currency: "USD" } },
    { currency: "USD" },
    { preferences: { currency: "USD" } },
  ].forEach((payload) => assert.equal(containsProtectedAdminFields(payload), true));
});

test("admin settings policy allows only persisted preference and notification fields", () => {
  assert.equal(containsProtectedAdminFields({
    preferences: { language: "Filipino" },
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

test("admin cannot change currency through either preferences endpoint", async () => {
  for (const [handler, body] of [
    [updateSettings, { preferences: { currency: "USD" } }],
    [updatePreferences, { currency: "USD" }],
  ]) {
    let saved = false;
    const response = responseRecorder();
    await handler({ body, authUser: { role: "admin", save: async () => { saved = true; } } }, response.res);
    assert.equal(response.result().statusCode, 403);
    assert.equal(saved, false);
  }
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

test("customer display preferences persist while admin preferences retain branch authority", async () => {
  for (const role of ["customer", "admin"]) {
    let saved;
    const user = {
      role,
      assignedBranch: "Cavite",
      preferences: { language: "English", theme: "light", currency: "PHP" },
      notifications: { push: true },
      privacy: {},
      async save() { saved = JSON.parse(JSON.stringify(this.toJSON())); },
      toJSON() { return { role: this.role, assignedBranch: this.assignedBranch, preferences: this.preferences, notifications: this.notifications }; },
    };
    const response = responseRecorder();
    await updateSettings({ authUser: user, body: {
      preferences: { language: "Filipino", theme: "dark", ...(role === "customer" ? { currency: "USD" } : {}), timezone: "Asia/Manila", autoBook: false },
      notifications: { push: false },
    } }, response.res);
    assert.equal(response.result().statusCode, 200);
    assert.equal(saved.preferences.language, "Filipino");
    assert.equal(saved.preferences.theme, "dark");
    assert.equal(saved.preferences.darkMode, true);
    assert.equal(saved.preferences.currency, role === "customer" ? "USD" : "PHP");
    assert.equal(saved.preferences.autoBook, false);
    assert.equal(saved.notifications.push, false);
    assert.equal(saved.assignedBranch, "Cavite");
  }
});
