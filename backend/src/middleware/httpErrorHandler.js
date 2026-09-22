const normalizeHttpStatus = (error = {}) => {
  const status = Number(error.statusCode || error.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
};

const httpErrorHandler = (error, _req, res, _next) => {
  const status = normalizeHttpStatus(error);
  if (status === 500) console.error(error);
  const message = status < 500 && String(error?.message || "").trim()
    ? String(error.message).trim()
    : "Internal server error";

  const body = { message };
  if (status === 409 && Array.isArray(error?.conflicts) && error.conflicts.length) {
    body.conflicts = error.conflicts;
  }

  return res.status(status).json(body);
};

module.exports = {
  httpErrorHandler,
  normalizeHttpStatus,
};
