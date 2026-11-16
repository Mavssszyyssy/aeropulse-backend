const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const BranchCoverage = require("../src/models/BranchCoverage");
const { createStaff } = require("../src/controllers/staffController");
const { updateProfileById } = require("../src/controllers/userController");
const { requireAuthNoBranch } = require("../src/middleware/auth");
const { signUserAccessToken } = require("../src/utils/token");

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

test("explicit removal clears both branch fields and revokes the administrator's session", async (t) => {
  const target = new User({ role: "admin", assignedBranch: "Cavite", activeBranch: "Cavite", security: { sessionVersion: 3 } });
  const oldToken = signUserAccessToken(target);
  t.mock.method(User, "findById", async () => target);
  t.mock.method(User, "findOneAndUpdate", async (filter, changes) => {
    assert.equal(String(filter._id), target.id);
    assert.equal(filter.assignedBranch, "Cavite");
    assert.equal(filter.activeBranch, "Cavite");
    assert.deepEqual(changes.$inc, { "security.sessionVersion": 1 });
    target.set(changes.$set);
    target.security.sessionVersion += 1;
    return target;
  });
  const req = { authUser: { role: "superadmin" }, params: { id: target.id }, body: { unassignBranch: "Cavite" } };
  const res = response();
  await updateProfileById(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.assignedBranch, "");
  assert.equal(res.body.user.activeBranch, "");
  assert.equal(res.body.user.accountStatus, "active");

  t.mock.method(BranchCoverage, "bulkWrite", async () => {});
  t.mock.method(BranchCoverage, "find", () => ({
    select: () => ({ sort: () => ({ lean: async () => [{ name: "Cavite" }, { name: "Bulacan" }] }) }),
  }));
  for (const [token, expectedStatus] of [[oldToken, 401], [signUserAccessToken(target), 400]]) {
    const authResponse = response();
    await requireAuthNoBranch(
      { method: "POST", headers: { authorization: `Bearer ${token}` }, originalUrl: "/api/contact-messages" },
      authResponse,
      () => assert.fail("An administrator with no branch cannot reach protected branch data"),
    );
    assert.equal(authResponse.statusCode, expectedStatus);
  }
});

test("only Superadmin can remove the matching current assignment", async (t) => {
  const target = new User({ role: "admin", assignedBranch: "Cavite", activeBranch: "Cavite" });
  t.mock.method(User, "findById", async () => target);
  const write = t.mock.method(User, "findOneAndUpdate", async () => null);
  for (const [authUser, branch, expectedStatus] of [
    [target, "Cavite", 403],
    [{ role: "superadmin" }, "Bulacan", 409],
    [{ role: "superadmin" }, "", 400],
  ]) {
    const res = response();
    await updateProfileById({ authUser, params: { id: target.id }, body: { unassignBranch: branch } }, res);
    assert.equal(res.statusCode, expectedStatus);
  }
  assert.equal(write.mock.callCount(), 0);
});
