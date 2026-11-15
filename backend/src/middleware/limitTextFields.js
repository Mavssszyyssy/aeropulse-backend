function textFieldError(value, max, label, list = false) {
  if (value == null) return "";
  const values = list && Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string")) return `${label} must be text.`;
  return values.join(",").length > max ? `${label} must be ${max} characters or fewer.` : "";
}

/**
 * Check only named request fields. Optional fields can be absent. Never
 * truncate a submission or rewrite a stored value to fit a new limit.
 */
function limitTextFields(fields, getBodies = body => [body]) {
  const limits = Object.entries(fields).map(([field, [max, label, list = false]]) => [field, field.split("."), max, label, list]);
  return (req, res, next) => {
    for (const body of getBodies(req.body)) {
      for (const [field, path, max, label, list] of limits) {
        const value = path.reduce((parent, key) => parent?.[key], body);
        const message = textFieldError(value, max, label, list);
        if (message) return res.status(400).json({ message, fields: { [field]: message } });
      }
    }
    return next();
  };
}

module.exports = { limitTextFields, textFieldError };
