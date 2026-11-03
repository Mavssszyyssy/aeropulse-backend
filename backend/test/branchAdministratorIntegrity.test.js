const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { createStaff } = require("../src/controllers/staffController");
const { updateProfileById } = require("../src/controllers/userController");

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("creating a second active administrator for a branch is rejected", async (t) => {
  t.mock.method(User, "exists", async () => ({ _id: "existing" }));
  const res = response();
  await createStaff({ authUser: { role: "superadmin" }, body: { role: "admin", branch: "Bulacan", name_first: "Ana", name_last: "Cruz", email: "ana@example.com" } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /already has an active administrator/i);
});

test("branch administrator edits cannot silently replace the current owner", async (t) => {
  const target = new User({ role: "admin", assignedBranch: "Cavite", activeBranch: "Cavite", name_first: "Ben", name_last: "Reyes", email: "ben@example.com" });
  t.mock.method(User, "findById", async () => target);
  t.mock.method(User, "exists", async () => ({ _id: "existing" }));
  const save = t.mock.method(target, "save", async () => target);
  const res = response();
  await updateProfileById({ authUser: { role: "superadmin" }, params: { id: String(target._id) }, body: { assignedBranch: "Bulacan", activeBranch: "Bulacan" } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(target.assignedBranch, "Cavite");
  assert.equal(save.mock.callCount(), 0);
});
