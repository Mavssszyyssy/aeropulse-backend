const { validateTextRequest } = require("../domain/textFieldValidation");
const { isKnownServiceArea } = require("../domain/branchInputValidation");
function requestTextValidation(req, res, next) {
  const error = validateTextRequest(req.originalUrl || req.url, req.method, req.body, { validateLocation: isKnownServiceArea });
  if (error) return res.status(400).json({ message: error.message, errors: { [error.field]: error.message } });
  return next();
}
module.exports = { requestTextValidation };
