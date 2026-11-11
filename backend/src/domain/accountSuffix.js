const MAX_ACCOUNT_SUFFIX_LENGTH = 12;

const validateAccountSuffix = (value) => {
  const suffix = String(value ?? "").trim();
  if (!suffix) return { value: "", error: "" };
  if (suffix.length > MAX_ACCOUNT_SUFFIX_LENGTH || !/^[\p{L}\p{M}]+(?:[ .'-][\p{L}\p{M}]+)*\.?$/u.test(suffix) || /(.)\1{4,}/iu.test(suffix)) {
    return { value: suffix, error: "Suffix must be 12 characters or fewer and use letters, spaces, periods, apostrophes, or hyphens." };
  }
  return { value: suffix, error: "" };
};

module.exports = { MAX_ACCOUNT_SUFFIX_LENGTH, validateAccountSuffix };
