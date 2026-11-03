const validatePersonName = (value, label = "Name") => {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return { value: "", error: `${label} is required.` };
  if (text.length < 2 || text.length > 60) return { value: text, error: `${label} must be 2–60 characters.` };
  if (!/^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u.test(text)) {
    return { value: text, error: `${label} may contain letters, spaces, apostrophes, periods, and hyphens only.` };
  }
  if (/(.)\1{5,}/iu.test(text)) return { value: text, error: `${label} contains too many repeated characters.` };
  return { value: text, error: "" };
};

module.exports = { validatePersonName };
