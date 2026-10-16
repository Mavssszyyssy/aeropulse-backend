const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePostalCodeForAddress } = require("../src/utils/postalCodeValidation");
const { getScheduledDateError } = require("../src/utils/scheduling");
const { validateStrictServicePayload } = require("../src/domain/serviceCompletionService");
const { effectiveWarrantyStatus, getWarrantyRecommendation } = require("../src/domain/warrantyService");
const { formatDateKeyInTimeZone } = require("../src/utils/dateTime");

test("ZIP codes must match the selected city", () => {
  const address = { region: "CALABARZON", province: "Cavite", city: "Bacoor" };
  assert.equal(validatePostalCodeForAddress({ ...address, postalCode: "4102" }), "");
  assert.match(validatePostalCodeForAddress({ ...address, postalCode: "1000" }), /does not match/i);
  assert.match(validatePostalCodeForAddress({ ...address, postalCode: "410" }), /exactly 4 digits/i);
  assert.match(validatePostalCodeForAddress({ ...address, city: "Quezon City", postalCode: "1100" }), /city, province, and region/i);

  const pasayAddress = {
    region: "NCR",
    province: "Metro Manila",
    city: "Pasay City",
    barangay: "Barangay 142",
  };
  assert.equal(validatePostalCodeForAddress({ ...pasayAddress, postalCode: "1300" }), "");
  assert.match(validatePostalCodeForAddress({ ...pasayAddress, postalCode: "4102" }), /does not match/i);

  const muntinlupaAddress = {
    region: "National Capital Region (NCR)",
    province: "Metro Manila",
    city: "City of Muntinlupa",
    barangay: "Alabang",
  };
  assert.equal(validatePostalCodeForAddress({ ...muntinlupaAddress, postalCode: "1770" }), "");
  assert.equal(validatePostalCodeForAddress({ ...muntinlupaAddress, postalCode: "1780" }), "");
  assert.match(validatePostalCodeForAddress({ ...muntinlupaAddress, postalCode: "1300" }), /does not match/i);
});

test("service dates reject invalid and past calendar dates", () => {
  assert.match(getScheduledDateError("2026-02-30"), /valid calendar date/i);
  assert.match(getScheduledDateError("2020-01-01"), /cannot be in the past/i);
  assert.equal(getScheduledDateError("2099-12-31"), "");
});

test("technician service completion requires real report details", () => {
  const empty = validateStrictServicePayload({});
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys(empty.errors).sort(), [
    "conditionRating",
    "findings",
    "serviceActions",
    "serviceType",
  ]);

  const valid = validateStrictServicePayload({
    serviceType: "deep_cleaning",
    findings: "Evaporator coil had heavy dust buildup.",
    serviceActions: ["Cleaned evaporator coil", "Flushed drain line"],
    conditionRating: "fair",
    serviceDate: "2026-01-15",
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.values.serviceType, "deep_cleaning");
});

test("pending warranty activation gives automatic, customer-safe guidance", () => {
  assert.match(
    getWarrantyRecommendation({ status: "pending_activation" }),
    /no action is needed/i,
  );
  assert.match(
    getWarrantyRecommendation({ status: "pending_activation" }),
    /technician completes and verifies/i,
  );
  assert.doesNotMatch(
    getWarrantyRecommendation({ status: "pending_activation" }),
    /warranty is active/i,
  );
});

test("claim decisions never replace active warranty coverage", () => {
  const coverage = { startDate: "2026-01-01", expirationDate: "2031-01-01" };
  assert.equal(effectiveWarrantyStatus({ ...coverage, status: "under_review" }), "active");
  assert.equal(effectiveWarrantyStatus({ ...coverage, status: "approved" }), "active");
  assert.equal(effectiveWarrantyStatus({ ...coverage, status: "rejected" }), "active");
  assert.match(
    getWarrantyRecommendation({
      ...coverage,
      status: "active",
      claims: [{ status: "approved", serviceRequestId: "SR-100", reviewedAt: "2026-08-31T20:00:00.000Z" }],
    }),
    /service request was created/i,
  );
  assert.doesNotMatch(
    getWarrantyRecommendation({
      ...coverage,
      status: "active",
      claims: [{ status: "approved", serviceRequestId: "SR-100", reviewedAt: "2026-08-31T20:00:00.000Z" }],
    }),
    /scheduled/i,
  );
});

test("business dates use the Philippine calendar boundary", () => {
  assert.equal(
    formatDateKeyInTimeZone(new Date("2026-08-31T16:30:00.000Z")),
    "2026-09-01",
  );
});
