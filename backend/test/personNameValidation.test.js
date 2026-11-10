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
  for (const value of ["", "   ", "A", "hhhhhhhhhhhhhhhhhhhhhhhh", "Patrickjhhhhjhhhhhgggsa", "John123", "-Maria", "Alexandra".repeat(4).slice(0, 31)]) {
    assert.ok(validatePersonName(value, "First name").error, value);
  }
  assert.equal(validatePersonName("Alexandra".repeat(4).slice(0, 30), "First name").error, "");
  assert.match(validatePersonName("Alexandra".repeat(4).slice(0, 31), "Last name").error, /2–30/);
  assert.equal(validatePersonName("Alexandra".repeat(7).slice(0, 60), "Recipient name", { maxLength: 60 }).error, "");
});
