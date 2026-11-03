const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { requireAuth } = require("../src/middleware/auth");
const { signUserAccessToken } = require("../src/utils/token");

test("a disabled customer cannot use an otherwise valid session", async (t) => {
  const user = new User({
    name_first: "Test",
    name_last: "Customer",
    role: "customer",
    accountStatus: "disabled",
  });
  t.mock.method(User, "findById", async () => user);
  const token = signUserAccessToken(user);
  let advanced = false;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await requireAuth({ method: "POST", headers: { authorization: `Bearer ${token}` }, originalUrl: "/api/orders" }, res, () => { advanced = true; });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /not active/i);
  assert.equal(advanced, false);
});
