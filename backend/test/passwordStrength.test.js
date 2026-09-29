const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_REGISTRATION_PASSWORD_SCORE,
  calculatePasswordStrength,
  passwordStrengthLabel,
} = require("../src/domain/passwordStrength");

test("password strength is the normalized score used by registration", () => {
  assert.equal(calculatePasswordStrength(""), 0);
  assert.ok(calculatePasswordStrength("StrongPass1!") >= MIN_REGISTRATION_PASSWORD_SCORE);
  assert.equal(calculatePasswordStrength("CorrectHorseBatteryStaple!29"), 100);
  assert.ok(calculatePasswordStrength("A-very-long-unpredictable-password!2026") <= 100);
});

test("password labels match the normalized score boundaries", () => {
  assert.equal(passwordStrengthLabel(35), "Weak");
  assert.equal(passwordStrengthLabel(60), "Moderate");
  assert.equal(passwordStrengthLabel(80), "Strong");
  assert.equal(passwordStrengthLabel(100), "Excellent");
  assert.equal(passwordStrengthLabel(133), "Excellent");
});
