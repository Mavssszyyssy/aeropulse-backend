const test = require("node:test");
const assert = require("node:assert/strict");
const {
  httpErrorHandler,
  normalizeHttpStatus,
} = require("../src/middleware/httpErrorHandler");

const response = () => ({
  statusCode: 200,
  body: null,
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; },
});

test("operational HTTP errors retain their status and useful message", () => {
  const error = new Error("Technician is already assigned during this time slot.");
  error.status = 409;
  error.conflicts = [{ taskCode: "TSK-CONFLICT", timeSlot: "9:00 AM - 12:00 PM" }];
  const res = response();

  httpErrorHandler(error, {}, res, () => {});

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, error.message);
  assert.deepEqual(res.body.conflicts, error.conflicts);
});

test("unexpected errors remain private and return a generic 500", () => {
  const res = response();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    httpErrorHandler(new Error("database password leaked here"), {}, res, () => {});
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: "Internal server error" });
});

test("invalid or successful status values cannot bypass the 500 fallback", () => {
  assert.equal(normalizeHttpStatus({ status: 200 }), 500);
  assert.equal(normalizeHttpStatus({ statusCode: "not-a-number" }), 500);
  assert.equal(normalizeHttpStatus({ statusCode: 422 }), 422);
});
