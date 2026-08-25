const crypto = require("crypto");
const env = require("../config/env");

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    best_serviced_by: { type: "string" },
    recommended_service: { type: "string", enum: ["regular_cleaning", "deep_cleaning"] },
    recommendation_summary: { type: "string" },
    capacity_assessment: {
      type: "string",
      enum: ["suitable", "insufficient", "higher_than_necessary", "room_size_required", "capacity_required"],
    },
    technician_preparation: { type: "array", items: { type: "string" } },
  },
  required: ["best_serviced_by", "recommended_service", "recommendation_summary", "capacity_assessment", "technician_preparation"],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanText = (value, max = 500) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);

const responseText = (payload = {}) => {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
};

const callStructuredAmpAnalysis = async (input) => {
  if (!env.openAiApiKey) return { provider: "system-fallback", insight: null };
  const requestId = `amp-${crypto.randomUUID()}`;
  const attempts = Math.max(1, Number(env.openAiMaxRetries || 2) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(env.openAiTimeoutMs || 20000)));
    try {
      const response = await fetch(`${String(env.openAiBaseUrl).replace(/\/$/, "")}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openAiApiKey}`,
          "X-Client-Request-Id": requestId,
        },
        body: JSON.stringify({
          model: env.openAiModel,
          store: false,
          input: [
            {
              role: "developer",
              content: [{
                type: "input_text",
                text: "You are AEROPULSE's predictive-maintenance decision-support assistant. Use only supplied records. Never invent service history, diagnoses, failures, or parts. The backend-calculated date, service type, and capacity result are authoritative. Provide a concise explanation and only suggest preparation items that occur in recorded component history.",
              }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: JSON.stringify(input) }],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "amp_maintenance_recommendation",
              strict: true,
              schema: OUTPUT_SCHEMA,
            },
          },
        }),
      });
      const serverRequestId = response.headers.get("x-request-id") || requestId;
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`OpenAI request failed with status ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.requestId = serverRequestId;
        error.status = response.status;
        throw error;
      }
      const payload = JSON.parse(body);
      const parsed = JSON.parse(responseText(payload));
      return { provider: "openai", insight: parsed, requestId: serverRequestId };
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || error.retryable || error instanceof TypeError;
      console.warn("OpenAI AMP request failed", {
        requestId: error.requestId || requestId,
        attempt,
        status: error.status || null,
        reason: error.name === "AbortError" ? "timeout" : cleanText(error.message, 160),
      });
      if (!retryable || attempt >= attempts) break;
      await sleep(250 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    provider: "system-fallback",
    insight: null,
    error: lastError?.name === "AbortError" ? "OpenAI request timed out." : "OpenAI analysis is temporarily unavailable.",
  };
};

const validateAmpInsight = (raw, deterministic) => {
  const allowedComponents = new Set((deterministic.commonComponents || []).map((item) => cleanText(item.component, 100)));
  const suggestions = Array.isArray(raw?.technician_preparation)
    ? raw.technician_preparation.map((item) => cleanText(item, 100)).filter((item) => allowedComponents.has(item)).slice(0, 5)
    : [];
  return {
    best_serviced_by: deterministic.bestServicedBy.slice(0, 10),
    recommended_service: deterministic.recommendedService,
    recommendation_summary: cleanText(raw?.recommendation_summary, 500) || deterministic.recommendationBasis,
    capacity_assessment: deterministic.capacityAssessment.status,
    technician_preparation: suggestions,
  };
};

module.exports = { callStructuredAmpAnalysis, validateAmpInsight };
