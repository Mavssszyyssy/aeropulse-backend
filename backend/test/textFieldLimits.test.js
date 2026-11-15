const test = require("node:test");
const assert = require("node:assert/strict");
const { limitTextFields } = require("../src/middleware/limitTextFields");
const { workOrderText, serviceReportText, changedServiceLogTextError } = require("../src/middleware/workOrderText");

function validate(middleware, body) {
  let passed = false;
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
  };
  middleware({ body }, response, () => { passed = true; });
  return { passed, status: response.statusCode, fields: response.body?.fields };
}

test("limits changed work-order notes without touching existing records or other fields", () => {
  const notes = "x".repeat(1000);
  assert.equal(validate(workOrderText, { schedule: { notes } }).passed, true);
  const update = { schedule: { notes: notes + "x" }, status: "pending" };
  const result = validate(workOrderText, update);
  assert.equal(result.status, 400);
  assert.equal(result.fields["schedule.notes"], "Schedule note must be 1000 characters or fewer.");
  assert.equal(update.schedule.notes.length, 1001);
  assert.equal(validate(workOrderText, { priority: "normal" }).passed, true);
});

test("service-report limits cover notes in proof without limiting attachments", () => {
  assert.equal(validate(serviceReportText, { findings: "Fixed drain", proof: { notes: "", afterPhotos: [{ uri: "x".repeat(2048) }] } }).passed, true);
  assert.equal(validate(serviceReportText, { findings: "Preset finding.\n" + "x".repeat(1000) }).passed, true);
  assert.equal(validate(serviceReportText, { proof: { notes: "x".repeat(1501) } }).status, 400);
  assert.equal(validate(serviceReportText, { notes: { value: "not text" } }).status, 400);
});

test("existing long service notes remain readable and do not block saving a separate note", () => {
  const legacy = { id: "old", notes: "x".repeat(1200) };
  assert.equal(changedServiceLogTextError([legacy, { id: "new", notes: "New note" }], [legacy]), "");
  assert.match(changedServiceLogTextError([{ ...legacy, notes: legacy.notes + "x" }], [legacy]), /1000 characters/);
});

test("catalog features and nested address fields enforce their own limits", () => {
  const catalog = limitTextFields({ features: [5, "Features", true] });
  assert.equal(validate(catalog, { features: ["aa", "bb"] }).passed, true);
  assert.equal(validate(catalog, { features: ["aa", "bbb"] }).status, 400);
  const address = limitTextFields({ "location.address.street": [180, "Street address"] });
  assert.equal(validate(address, { location: { address: { street: "x".repeat(181) } } }).status, 400);
});
