const test = require("node:test");
const assert = require("node:assert/strict");
const env = require("../src/config/env");
const { callStructuredAmpAnalysis, validateAmpInsight, resolveBusinessIntelligence, validBusinessIntelligenceSelection } = require("../src/services/openAiAmpService");

test("operational report interpretations reuse the authorized snapshot and reject provider figures", async (t) => {
  const originalKey = env.openAiApiKey;
  env.openAiApiKey = "mock-report-key";
  t.after(() => { env.openAiApiKey = originalKey; });

  const insight = { summary: "Low stock is visible in the selected inventory.", review_action: "Verify quantities against the branch stock register." };
  let responseInsight = insight;
  const fetch = t.mock.method(global, "fetch", async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ output_text: JSON.stringify(responseInsight) }),
  }));
  const input = {
    safetyIdentifier: "mock-viewer",
    reportInterpretation: {
      report: "inventory", language: "English", scope: { branch: "Cavite", stockFilter: "all" },
      statistics: { productLines: 4, lowStockItems: 2, outOfStockItems: 0 },
    },
  };
  const result = await callStructuredAmpAnalysis(input);
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.insight, insight);
  assert.equal((await callStructuredAmpAnalysis(input)).cached, true);
  assert.equal(fetch.mock.callCount(), 1);
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.deepEqual(JSON.parse(body.input[1].content[0].text), input.reportInterpretation);
  assert.equal(body.store, false);

  responseInsight = { ...insight, summary: "There are 200 units left." };
  const wrongFigures = await callStructuredAmpAnalysis({ ...input, safetyIdentifier: "another-viewer" });
  assert.equal(wrongFigures.provider, "system-fallback");
  assert.equal(wrongFigures.insight, null);
});

test("AMP uses the deterministic fallback when no provider key exists", async () => {
  const originalKey = env.openAiApiKey;
  env.openAiApiKey = "";
  const result = await callStructuredAmpAnalysis({ recommendation: {} });
  env.openAiApiKey = originalKey;
  assert.equal(result.provider, "system-fallback");
  assert.equal(result.insight, null);
});

test("AMP sends the configured GPT-5.6 Terra reasoning profile", async () => {
  const originalKey = env.openAiApiKey;
  const originalModel = env.openAiModel;
  const originalEffort = env.openAiReasoningEffort;
  const originalFetch = global.fetch;
  let requestBody = null;

  env.openAiApiKey = "test-key";
  env.openAiModel = "gpt-5.6-terra";
  env.openAiReasoningEffort = "none";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      headers: { get: () => "req_test_terra" },
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          explanation_fact_ids: ["schedule", "method"],
        }),
      }),
    };
  };

  try {
    const result = await callStructuredAmpAnalysis({ recommendation: { bestServicedBy: "2027-05-11", recommendedService: "regular_cleaning" } });
    assert.equal(result.provider, "openai");
    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.deepEqual(requestBody.reasoning, { effort: "none" });
    assert.equal(requestBody.store, false);
  } finally {
    env.openAiApiKey = originalKey;
    env.openAiModel = originalModel;
    env.openAiReasoningEffort = originalEffort;
    global.fetch = originalFetch;
  }
});

test("validated AI output cannot replace authoritative calculations", () => {
  const deterministic = {
    bestServicedBy: "2027-05-11T00:00:00.000Z",
    recommendedService: "regular_cleaning",
    recommendationBasis: "Recorded maintenance interval.",
    capacityAssessment: { status: "suitable" },
  };
  const result = validateAmpInsight({
    best_serviced_by: "2099-01-01",
    recommended_service: "deep_cleaning",
    recommendation_summary: "Concise explanation.",
    capacity_assessment: "insufficient",
  }, deterministic);
  assert.equal(result.best_serviced_by, "2027-05-11");
  assert.equal(result.recommended_service, "regular_cleaning");
  assert.equal(result.capacity_assessment, "suitable");
  assert.equal(result.recommendation_summary, deterministic.recommendationBasis);
  assert.deepEqual(Object.keys(result).sort(), [
    "best_serviced_by",
    "capacity_assessment",
    "recommendation_summary",
    "recommended_service",
  ]);
});

test("manager business intelligence lets AI prioritize only verified fact identifiers", async () => {
  const originalKey = env.openAiApiKey;
  const originalFetch = global.fetch;
  let requestBody;
  env.openAiApiKey = "test-business-key";
  const facts = {
    sales_total: { id: "sales_total", category: "sales", statement: "Verified sales total.", action: "Review sales." },
    service_total: { id: "service_total", category: "service", statement: "Verified service total.", action: "Review workload." },
    inventory_low: { id: "inventory_low", category: "inventory", statement: "Verified low stock.", action: "Review stock." },
    amp_due: { id: "amp_due", category: "amp", statement: "Verified AMP due count.", action: "Review units." },
  };
  const selection = { sales_fact_ids: ["sales_total"], service_fact_ids: ["service_total"], inventory_fact_ids: ["inventory_low"], amp_fact_ids: ["amp_due"] };
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, headers: { get: () => "bi-request" }, text: async () => JSON.stringify({ output_text: JSON.stringify(selection) }) };
  };
  try {
    const result = await callStructuredAmpAnalysis({ businessIntelligence: true, intelligenceFacts: facts, safetyIdentifier: `manager-${Date.now()}` });
    assert.equal(result.provider, "openai");
    assert.equal(requestBody.text.format.name, "manager_business_intelligence");
    assert.equal(validBusinessIntelligenceSelection(selection, facts), true);
    assert.equal(validBusinessIntelligenceSelection({ ...selection, sales_fact_ids: ["inventory_low"] }, facts), false);
    const resolved = resolveBusinessIntelligence(facts, result);
    assert.equal(resolved.provider, "openai");
    assert.equal(resolved.insights.inventory[0].statement, "Verified low stock.");
  } finally {
    env.openAiApiKey = originalKey;
    global.fetch = originalFetch;
  }
});
