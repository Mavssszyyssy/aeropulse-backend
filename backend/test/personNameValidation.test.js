const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePersonName } = require("../src/domain/personNameValidation");

test("names preserve legitimate Filipino and international spelling", () => {
  for (const value of ["Dela Cruz", "O'Neill", "Anne-Marie", "José", " María ", "Renée"] ) {
    assert.equal(validatePersonName(value, "First name").error, "", value);
  }
  assert.equal(validatePersonName(" María ").value, "María");
});

test("names reject empty, unrealistic, malformed and overly long values", () => {
  for (const value of ["", "   ", "A", "hhhhhhhhhhhhhhhhhhhhhhhh", "John123", "-Maria", "a".repeat(61)]) {
    assert.ok(validatePersonName(value, "First name").error, value);
  }
});
