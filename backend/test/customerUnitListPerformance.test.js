const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { listMyUnits } = require("../src/controllers/ampController");
const Unit = require("../src/models/Unit");
const Order = require("../src/models/Order");
const ServiceHistory = require("../src/models/ServiceHistory");
const ServiceRequest = require("../src/models/ServiceRequest");
const User = require("../src/models/User");

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

test("customer unit listing uses serial-specific purchase branches and recorded installing technicians", async (t) => {
  const customer = "66fa00000000000000000001";
  const installer = "66fa00000000000000000002";
  const otherInstaller = "66fa00000000000000000003";
  const installedAt = "2025-09-10T00:00:00Z";
  const units = [
    { _id: "unit-1", serialNumber: "SERIAL-1", serviceBranch: "Laguna", installation: { installedAt, installedBy: installer } },
    { _id: "unit-2", serialNumber: "SERIAL-2", installation: { installedAt } },
    { _id: "unit-3", serialNumber: "SERIAL-3", serviceBranch: "Bulacan", installation: { installedAt } },
  ];
  t.mock.method(Unit, "find", (filter) => {
    assert.equal(filter.customer, customer);
    return { sort: async () => units };
  });
  t.mock.method(Order, "find", (filter) => {
    assert.equal(filter.customer, customer);
    return { select: (fields) => {
      assert.match(fields, /items\.sourceBranch/);
      return { sort: async () => [{
        orderCode: "ORD-1", stockSourceBranch: "Bulacan",
        items: [
          { sourceBranch: "Cavite", serialUnits: [{ serialNumber: "SERIAL-1" }] },
          { sourceBranch: "Bulacan", serialNumbers: ["SERIAL-2"] },
        ],
      }] };
    } };
  });
  t.mock.method(ServiceHistory, "find", () => ({ sort: () => ({ lean: async () => [
    { unit: "unit-2", technician: otherInstaller, serviceType: "installation", serviceDate: installedAt },
    { unit: "unit-3", technician: otherInstaller, serviceType: "repair" },
  ] }) }));
  t.mock.method(ServiceRequest, "find", () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }));
  const names = t.mock.method(User, "find", ({ _id }) => {
    assert.deepEqual(_id.$in, [installer, otherInstaller]);
    return { select: (fields) => {
      assert.equal(fields, "name name_first name_last");
      return { lean: async () => [
        { _id: installer, name: "Alex Santos" },
        { _id: otherInstaller, name_first: "Jo", name_last: "Cruz" },
      ] };
    } };
  });
  let payload;
  await listMyUnits({ authUser: { _id: customer } }, { json: (value) => { payload = value; } });
  assert.equal(names.mock.callCount(), 1);
  assert.deepEqual(payload.units.map(({ purchaseBranch, serviceBranch, installingTechnician }) => ({ purchaseBranch, serviceBranch, installingTechnician })), [
    { purchaseBranch: "Cavite", serviceBranch: "Laguna", installingTechnician: "Alex Santos" },
    { purchaseBranch: "Bulacan", serviceBranch: "", installingTechnician: "Jo Cruz" },
    { purchaseBranch: "", serviceBranch: "Bulacan", installingTechnician: "" },
  ]);
});
