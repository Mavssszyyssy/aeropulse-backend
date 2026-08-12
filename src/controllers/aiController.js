const env = require("../config/env");

function safeJsonParse(value) {
  if (!value) return null;

  const raw = String(value)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toCompactHistory(items = [], fields = []) {
  return items.slice(0, 8).map((item) => {
    const next = {};
    fields.forEach((field) => {
      if (item && item[field] !== undefined && item[field] !== null) {
        next[field] = item[field];
      }
    });
    return next;
  });
}

function buildPrompt(unit, requests, tasks, baseline) {
  return [
    "You are an AC diagnostic assistant for a service mobile app.",
    "Use the provided unit profile and history to estimate the overall unit health.",
    "Return only valid JSON with these keys: score, label, recommendation, summary, lifecycleLabel, estimatedRemainingMonths, estimatedRemainingYears, maintenanceIntervalMonths, nextMaintenanceDate, riskFactors.",
    "Rules:",
    "- score must be an integer from 0 to 100.",
    "- label should be one of Excellent, Good, Warning, or Critical.",
    "- nextMaintenanceDate must be YYYY-MM-DD or an empty string.",
    "- riskFactors must be an array of short strings.",
    "- Keep the result concise and practical for a customer-facing mobile screen.",
    `Baseline score: ${baseline.score}.`,
    `Baseline recommendation: ${baseline.recommendation}.`,
    `Unit data: ${JSON.stringify(unit)}`,
    `Service requests: ${JSON.stringify(toCompactHistory(requests, ["id", "status", "issueType", "issueDescription", "serviceType", "createdAt", "updatedAt", "preferredDate"]))}`,
    `Tasks: ${JSON.stringify(toCompactHistory(tasks, ["id", "status", "title", "description", "completionNotes", "createdAt", "updatedAt", "completedAt"]))}`,
  ].join("\n");
}

async function callOpenAI(prompt) {
  const response = await fetch(`${env.openAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openAiApiKey}`,
    },
    body: JSON.stringify({
      model: env.openAiModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You produce only JSON. Do not include markdown, code fences, or commentary.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${details}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || "";
  return safeJsonParse(content);
}

const getUnitHealthInsight = async (req, res) => {
  try {
    const { unit, requests = [], tasks = [], baseline = {} } = req.body || {};

    if (!unit || !unit.id) {
      return res.status(400).json({ message: "Unit data is required." });
    }

    if (!env.openAiApiKey) {
      return res.status(503).json({
        message: "OpenAI is not configured on the server.",
        provider: "unavailable",
      });
    }

    const prompt = buildPrompt(unit, requests, tasks, baseline);
    const insight = await callOpenAI(prompt);

    if (!insight) {
      return res.status(502).json({
        message: "OpenAI returned an invalid response.",
        provider: "openai",
      });
    }

    return res.json({
      provider: "openai",
      insight,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to generate AI unit health:", error);
    return res.status(500).json({
      message: "Unable to generate AI health right now.",
      provider: "error",
    });
  }
};

module.exports = { getUnitHealthInsight };