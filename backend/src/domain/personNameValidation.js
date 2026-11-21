const PERSON_NAME_MAX_LENGTH = 20;
const { validateHumanText } = require("./textFieldValidation");

const validatePersonName = (value, label = "Name", { maxLength = PERSON_NAME_MAX_LENGTH } = {}) => {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return { value: "", error: `${label} is required.` };
  if (text.length < 2 || text.length > maxLength) return { value: text, error: `${label} must be 2–${maxLength} characters.` };
  if (!text.split(/\s+/u).every((part) => /^[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}]+)*\.?$/u.test(part))) {
    return { value: text, error: `${label} may contain letters, spaces, apostrophes, periods, and hyphens only.` };
  }
  if (/(.)\1{4,}/iu.test(text)) return { value: text, error: `${label} contains too many repeated characters.` };
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
  const repeatedWords = words.some((word, index) => (
    (index >= 2 && word === words[index - 1] && word === words[index - 2]) ||
    (index >= 3 && word === words[index - 2] && words[index - 1] === words[index - 3])
  ));
  if (repeatedWords) return { value: text, error: `${label} contains repeated words.` };
  const contentError = validateHumanText(text, { max: maxLength, label, kind: "person" });
  if (contentError) return { value: text, error: contentError };
  return { value: text, error: "" };
};

module.exports = { validatePersonName };
