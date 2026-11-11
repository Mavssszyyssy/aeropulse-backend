const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAccountSuffix } = require("../src/domain/accountSuffix");

test("suffix is optional and preserves conventional values", () => {
  for (const suffix of ["", "Jr.", "Sr.", "III", "de la Cruz"]) {
    assert.equal(validateAccountSuffix(suffix).error, "", suffix);
  }
});

test("suffix rejects oversized and nonsensical values", () => {
  for (const suffix of ["1234567890123", "123", "Jr.123", "aaaaa", "!!!"]) {
    assert.ok(validateAccountSuffix(suffix).error, suffix);
  }
});
