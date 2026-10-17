const test = require("node:test");
const assert = require("node:assert/strict");
const Unit = require("../src/models/Unit");

test("unit follow-up accepts a completed visit whose AI evidence was not assessed", async () => {
  const unit = new Unit({
    serialNumber: "SCHEMA-NOT-ASSESSED-1",
    installation: { zipCode: "4102" },
    amp: {
      visitFollowUp: {
        severity: "not_assessed",
        evidenceConfidence: "not_assessed",
        provider: "system-fallback",
      },
    },
  });

  await assert.doesNotReject(unit.validate());
});
