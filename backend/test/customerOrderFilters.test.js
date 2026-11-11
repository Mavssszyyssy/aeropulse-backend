const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCustomerOrderFilter } = require("../src/domain/customerOrderFilters");

test("customer order filters retain ownership and match supported stages", () => {
  const filter = buildCustomerOrderFilter("customer-1", { orderStatus: "cancelled", paymentStatus: "pending" });
  assert.deepEqual(filter, { customer: "customer-1", workflowStatus: "cancelled", paymentStatus: "pending" });
  assert.deepEqual(buildCustomerOrderFilter("customer-1", { orderStatus: "invalid", paymentStatus: "invalid" }), { customer: "customer-1" });
});

test("customer order search treats user input literally and caps its length", () => {
  const filter = buildCustomerOrderFilter("customer-1", { search: "AC.*" });
  const pattern = filter.$and[0].$or.find((condition) => condition["items.name"])["items.name"];
  assert.equal(pattern.test("AC.*"), true);
  assert.equal(pattern.test("AC unit"), false);
  assert.equal(pattern.source, "AC\\.\\*");
  const longFilter = buildCustomerOrderFilter("customer-1", { search: "a".repeat(81), paymentStatus: "cancelled" });
  assert.equal(longFilter.customer, "customer-1");
  assert.equal(longFilter.$and[0].$or[0].paymentStatus, "cancelled");
  assert.equal(longFilter.$and[1].$or[0].orderCode.source, "a".repeat(80));
});

test("date presets use the current reference time", () => {
  const now = new Date("2026-11-11T00:00:00.000Z");
  const filter = buildCustomerOrderFilter("customer-1", { dateRange: "30d" }, now);
  assert.equal(filter.createdAt.$gte.toISOString(), "2026-10-12T00:00:00.000Z");
});
