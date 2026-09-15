const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("customer unit listing reuses loaded data and does not write notifications or maintenance state", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/controllers/ampController.js"),
    "utf8",
  );
  const start = controller.indexOf("const listMyUnits = async");
  const end = controller.indexOf("const updateRoomSize", start);
  const listing = controller.slice(start, end);

  assert.match(listing, /allHistory:\s*historyByUnit/);
  assert.match(listing, /serviceRequests:\s*requestsByUnit/);
  assert.match(listing, /cohortCache/);
  assert.match(listing, /persist:\s*false/);
  assert.doesNotMatch(listing, /notifyDueMaintenance\s*\(/);
});

test("customer history lookups have customer and creator indexes", () => {
  const model = fs.readFileSync(
    path.join(__dirname, "../src/models/ServiceRequest.js"),
    "utf8",
  );
  assert.match(model, /customerId:\s*1,\s*createdAt:\s*-1/);
  assert.match(model, /createdBy:\s*1,\s*createdAt:\s*-1/);
});
