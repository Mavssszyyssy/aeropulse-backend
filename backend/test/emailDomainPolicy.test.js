const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE,
  clearEmailDomainPolicyCache,
  extractEmailDomain,
  isDisposableEmailDomain,
  isValidDomain,
  validateEmailAddress,
} = require("../src/services/emailDomainPolicyService");

test.beforeEach(() => clearEmailDomainPolicyCache());

test("email policy validates normalized common providers and rejects malformed addresses", async () => {
  const allowed = await validateEmailAddress("  Person@GMAIL.COM  ");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.email, "person@gmail.com");
  assert.equal(allowed.domain, "gmail.com");
  assert.equal(extractEmailDomain("Person@Proton.Me"), "proton.me");

  for (const value of ["missing-at.example.com", "a..b@gmail.com", ".name@gmail.com", "name@gmail", "name@-gmail.com"]) {
    const result = await validateEmailAddress(value);
    assert.equal(result.ok, false, value);
    assert.equal(result.code, "invalid_format", value);
  }
});

test("email policy rejects unsupported and disposable providers with the shared message", async () => {
  const unsupported = await validateEmailAddress("person@example.com");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "unsupported_domain");
  assert.equal(unsupported.message, EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE);

  const disposable = await validateEmailAddress("person@sub.mailinator.com");
  assert.equal(disposable.ok, false);
  assert.equal(disposable.code, "disposable_domain");
  assert.equal(isDisposableEmailDomain("sub.mailinator.com"), true);
  assert.equal(isValidDomain("school.edu.ph"), true);
});
