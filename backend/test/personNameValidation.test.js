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
  for (const value of ["", "   ", "A", "hhhhhhhhhhhhhhhhhhhhhhhh", "Patrickjhhhhjhhhhhgggsa", "John123", "-Maria"]) {
    assert.ok(validatePersonName(value, "First name").error, value);
  }
  for (const label of ["First name", "Last name"]) {
    assert.equal(validatePersonName("Alexandra-Maria-Lynn", label).error, "");
    assert.match(validatePersonName("Alexandra-Maria-Lynne", label).error, /2–20/);
  }
  assert.equal(validatePersonName("Alexandra".repeat(7).slice(0, 60), "Recipient name", { maxLength: 60 }).error, "");
});

test("names reject repeated-word and repeated-phrase stuffing within the character limit", () => {
  for (const value of ["Test Test Test", "Test Name Test Name", "Juan Juan Juan"]) {
    assert.match(validatePersonName(value, "First name").error, /repeated words/, value);
  }
  assert.equal(validatePersonName("Maria Clara", "First name").error, "");
});
