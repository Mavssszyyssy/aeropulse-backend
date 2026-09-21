const test = require("node:test");
const assert = require("node:assert/strict");
const { hydrateRequestResponse } = require("../src/controllers/serviceRequestController");

test("lean service-request responses retain their persisted identifier", () => {
  const request = {
    _id: "66f0f2f46d3a2e0012345678",
    customer: "Patrick Cruz",
    status: "Submitted",
    payload: {
      customerName: "Patrick Cruz",
      issueDescription: "AMP recommended regular cleaning for this AC unit.",
      status: "Submitted",
    },
  };

  const result = hydrateRequestResponse(request);

  assert.equal(result.id, "66f0f2f46d3a2e0012345678");
  assert.equal(result.status, "Submitted");
});
