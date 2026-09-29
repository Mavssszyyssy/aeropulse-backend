const zxcvbn = require("zxcvbn");

const MIN_REGISTRATION_PASSWORD_SCORE = 65;

const calculatePasswordStrength = (password = "") => {
  if (!password) return 0;
  const result = zxcvbn(String(password));
  const rawScore = Math.floor(Number(result.guesses_log10 || 0) * 10);
  return Math.min(100, Math.max(0, rawScore));
};

const passwordStrengthLabel = (score = 0) => {
  const normalized = Math.min(100, Math.max(0, Number(score) || 0));
  if (normalized < 40) return "Weak";
  if (normalized < MIN_REGISTRATION_PASSWORD_SCORE) return "Moderate";
  if (normalized < 100) return "Strong";
  return "Excellent";
};

module.exports = {
  MIN_REGISTRATION_PASSWORD_SCORE,
  calculatePasswordStrength,
  passwordStrengthLabel,
};
