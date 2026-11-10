const validatePersonName = (value, label = "Name", { maxLength = 30 } = {}) => {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return { value: "", error: `${label} is required.` };
  if (text.length < 2 || text.length > maxLength) return { value: text, error: `${label} must be 2–${maxLength} characters.` };
  if (!/^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u.test(text)) {
    return { value: text, error: `${label} may contain letters, spaces, apostrophes, periods, and hyphens only.` };
  }
  if (/(.)\1{4,}/iu.test(text)) return { value: text, error: `${label} contains too many repeated characters.` };
  return { value: text, error: "" };
};

module.exports = { validatePersonName };
