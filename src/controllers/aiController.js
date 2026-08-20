const env = require("../config/env");
const mongoose = require("mongoose");
const Unit = require("../models/Unit");
const ServiceHistory = require("../models/ServiceHistory");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const { resolvePreferredBranch } = require("../domain/branchRouting");

const REPORT_TYPES = {
  root_cause_analysis: {
    label: "Root Cause Analysis",
    filenameLabel: "Root_Cause_Analysis",
    prompt: "Identify the most likely root causes from evidence. Separate observed facts from likely causes and state confidence without inventing sensor readings.",
  },
  predictive_maintenance: {
    label: "Predictive Maintenance Analysis",
    filenameLabel: "Predictive_Maintenance",
    prompt: "Forecast likely maintenance needs, urgency, and a preventive plan from the recorded service history and AMP condition data.",
  },
  ac_health_analysis: {
    label: "AC Health Analysis",
    filenameLabel: "AC_Health_Analysis",
    prompt: "Assess current AC health, risk level, key deterioration factors, and customer-safe maintenance actions.",
  },
  summary_report: {
    label: "Summary Report",
    filenameLabel: "Summary_Report",
    prompt: "Provide a branch-ready operational summary using only the supplied unit and service evidence.",
  },
};

const cleanText = (value, max = 300) => String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
const slugSegment = (value, fallback) => {
  const cleaned = cleanText(value, 80).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};
const asArray = (value, fallback = []) => Array.isArray(value) ? value.filter(Boolean).slice(0, 8) : fallback;
const reportDate = (value = new Date()) => new Date(value).toISOString().slice(0, 10);

function resolveResponsibleBranch(req, unit, requestedBranch = "") {
  const user = req.authUser || {};
  if (user.role === "superadmin" && cleanText(requestedBranch)) return cleanText(requestedBranch, 80);
  const branchFromInstallation = unit
    ? resolvePreferredBranch({
      city: unit.installation?.city || "",
      province: unit.installation?.province || "",
      street: unit.installation?.addressLine || "",
    })
    : "";
  return cleanText(unit?.serviceBranch || req.activeBranch || user.activeBranch || user.assignedBranch || requestedBranch || branchFromInstallation || "AEROPULSE Central", 80);
}

function formatHistoryItem(item = {}) {
  return {
    date: item.serviceDate || item.createdAt || item.updatedAt || "",
    type: cleanText(item.visitType || item.serviceType || item.issueType || "Service"),
    condition: cleanText(item.conditionRating || item.status || ""),
    notes: cleanText(item.technicianInputs?.notes || item.description || item.issue || ""),
    actions: asArray(item.serviceActions).map((action) => cleanText(action, 120)),
  };
}

function baselineHealth(unit, history) {
  const ampScore = Number(unit?.amp?.currentHealthScore);
  const lastCondition = String(history[0]?.conditionRating || "").toLowerCase();
  const score = Number.isFinite(ampScore)
    ? Math.max(0, Math.min(100, Math.round(ampScore)))
    : lastCondition === "poor" ? 45 : lastCondition === "fair" ? 65 : lastCondition === "excellent" ? 92 : 78;
  const label = score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 50 ? "Warning" : "Critical";
  return { score, label, riskLevel: score >= 85 ? "Low" : score >= 70 ? "Moderate" : score >= 50 ? "High" : "Critical" };
}

function buildFallbackReport({ type, unit, branch, history, requests, tasks }) {
  const health = baselineHealth(unit, history);
  const latest = history[0] || {};
  const serviceDue = unit?.amp?.nextIdealServiceDate ? new Date(unit.amp.nextIdealServiceDate).toISOString().slice(0, 10) : "Not scheduled";
  const issueCount = requests.length;
  const findings = [
    `Current AMP health classification is ${health.label} (${health.score}/100).`,
    latest?.serviceDate ? `Most recent recorded service was ${new Date(latest.serviceDate).toLocaleDateString("en-CA")}.` : "No completed service history is available yet.",
    `Next AMP service window: ${serviceDue}.`,
  ];
  if (issueCount) findings.push(`${issueCount} related service request${issueCount === 1 ? " is" : "s are"} recorded for review.`);
  const rootCauses = [{
    factor: latest?.technicianInputs?.filterCondition === "clogged" ? "Restricted airflow" : "Recorded service condition and usage pattern",
    evidence: cleanText(latest?.technicianInputs?.notes || latest?.conditionRating || "No technician diagnostic note has been recorded."),
    priority: health.riskLevel === "Low" ? "Monitor" : "Inspect",
  }];
  const recommendations = [
    health.score < 70 ? "Schedule a technician inspection before the next high-use period." : "Maintain the planned preventive-service interval.",
    "Document filter, coil, drainage, refrigerant, and voltage findings at the next visit.",
  ];
  return {
    title: REPORT_TYPES[type].label,
    executiveSummary: `${REPORT_TYPES[type].label} prepared for ${branch}. This assessment uses recorded AMP, installation, and service information only.`,
    health,
    findings,
    rootCauses,
    recommendations,
    maintenancePlan: [
      { timeframe: health.score < 70 ? "Within 7 days" : "At next AMP window", action: recommendations[0], reason: `Current risk level: ${health.riskLevel}.` },
      { timeframe: "Every service visit", action: recommendations[1], reason: "Keeps the AMP trend and warranty evidence complete." },
    ],
    confidence: history.length >= 2 || tasks.length >= 2 ? "Medium" : "Preliminary",
    note: "Generated from recorded system data because an OpenAI response was not available.",
  };
}

function normalizeReport(raw, fallback) {
  const value = raw && typeof raw === "object" ? raw : {};
  const healthSource = value.health && typeof value.health === "object" ? value.health : {};
  const score = Number(healthSource.score ?? value.score);
  return {
    ...fallback,
    title: cleanText(value.title, 120) || fallback.title,
    executiveSummary: cleanText(value.executiveSummary || value.summary, 900) || fallback.executiveSummary,
    health: {
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : fallback.health.score,
      label: cleanText(healthSource.label || value.label, 40) || fallback.health.label,
      riskLevel: cleanText(healthSource.riskLevel || value.riskLevel, 40) || fallback.health.riskLevel,
    },
    findings: asArray(value.findings, fallback.findings).map((item) => cleanText(typeof item === "string" ? item : item?.detail || item?.finding, 350)).filter(Boolean),
    recommendations: asArray(value.recommendations, fallback.recommendations).map((item) => cleanText(typeof item === "string" ? item : item?.action || item?.recommendation, 350)).filter(Boolean),
    rootCauses: asArray(value.rootCauses, fallback.rootCauses).map((item) => ({
      factor: cleanText(typeof item === "string" ? item : item?.factor, 160),
      evidence: cleanText(typeof item === "string" ? "Recorded evidence requires technician confirmation." : item?.evidence, 350),
      priority: cleanText(typeof item === "string" ? "Review" : item?.priority, 40) || "Review",
    })).filter((item) => item.factor),
    maintenancePlan: asArray(value.maintenancePlan, fallback.maintenancePlan).map((item) => ({
      timeframe: cleanText(typeof item === "string" ? "Recommended" : item?.timeframe, 80) || "Recommended",
      action: cleanText(typeof item === "string" ? item : item?.action, 350),
      reason: cleanText(typeof item === "string" ? "AMP recommendation" : item?.reason, 350),
    })).filter((item) => item.action),
    confidence: cleanText(value.confidence, 40) || fallback.confidence,
    note: cleanText(value.note, 500) || fallback.note,
  };
}

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

const generateAmpReport = async (req, res) => {
  try {
    const type = String(req.body?.reportType || "ac_health_analysis").trim().toLowerCase();
    const definition = REPORT_TYPES[type];
    if (!definition) return res.status(400).json({ message: "Unsupported AMP report type." });

    const requestedUnitId = String(req.body?.unitId || "").trim();
    if (!requestedUnitId || !mongoose.isValidObjectId(requestedUnitId)) {
      return res.status(400).json({ message: "Select a valid installed AC unit before generating a report." });
    }

    const unit = await Unit.findById(requestedUnitId);
    if (!unit) return res.status(404).json({ message: "Installed AC unit not found." });
    if (req.authUser.role === "customer" && String(unit.customer || "") !== String(req.authUser._id || "")) {
      return res.status(403).json({ message: "You are not allowed to generate a report for this AC unit." });
    }
    if (
      req.authUser.role !== "superadmin" &&
      req.activeBranch &&
      unit.serviceBranch &&
      unit.serviceBranch !== req.activeBranch
    ) {
      return res.status(403).json({ message: "This AC unit belongs to another branch." });
    }

    const branch = resolveResponsibleBranch(req, unit, req.body?.branch);
    const [history, requests, tasks] = await Promise.all([
      ServiceHistory.find({ unit: unit._id }).sort({ serviceDate: -1 }).limit(20).lean(),
      ServiceRequest.find({
        $or: [
          { unitId: String(unit._id) },
          { customerId: String(unit.customer || "") },
        ],
      }).sort({ createdAt: -1 }).limit(12).lean(),
      Task.find({
        $or: [
          { unitId: String(unit._id) },
          { "payload.serialNumbers": unit.serialNumber },
          { "payload.serialNumber": unit.serialNumber },
        ],
      }).sort({ updatedAt: -1 }).limit(12).lean(),
    ]);

    const compactUnit = {
      unitId: String(unit._id),
      qrUnitId: unit.qrUnitId || "",
      serialNumber: unit.serialNumber,
      brand: unit.brand,
      model: unit.modelName,
      installedAt: unit.installation?.installedAt || null,
      serviceBranch: branch,
      amp: unit.amp || {},
      warrantyStatus: unit.warranty?.status || "",
    };
    const fallback = buildFallbackReport({ type, unit, branch, history, requests, tasks });
    let provider = "system-fallback";
    let normalized = fallback;
    if (env.openAiApiKey) {
      try {
        const prompt = [
          "You are AEROPULSE's AC maintenance reporting assistant.",
          `Generate a professional ${definition.label}. ${definition.prompt}`,
          "Return JSON only with: title, executiveSummary, health { score, label, riskLevel }, findings, rootCauses [{ factor, evidence, priority }], recommendations, maintenancePlan [{ timeframe, action, reason }], confidence, note.",
          "Do not claim data that is not in the records. State when technician inspection is needed.",
          `Responsible branch: ${branch}.`,
          `AC unit: ${JSON.stringify(compactUnit)}.`,
          `Service history: ${JSON.stringify(history.map(formatHistoryItem))}.`,
          `Service requests: ${JSON.stringify(requests.map(formatHistoryItem))}.`,
          `Technician tasks: ${JSON.stringify(tasks.map(formatHistoryItem))}.`,
        ].join("\n");
        const insight = await callOpenAI(prompt);
        if (insight) {
          normalized = normalizeReport(insight, fallback);
          provider = "openai";
        }
      } catch (error) {
        console.error("OpenAI AMP report failed; using system fallback:", error.message || error);
      }
    }

    const generatedAt = new Date().toISOString();
    const date = reportDate(generatedAt);
    const identifier = slugSegment(unit.serialNumber || unit.qrUnitId, "AC-UNIT");
    const fileIdentifier = type === "summary_report"
      ? `Branch-${slugSegment(branch, "AEROPULSE")}`
      : identifier;
    const fileNameBase = `AMP_${definition.filenameLabel}_${fileIdentifier}_${date}`;
    return res.json({
      provider,
      report: {
        ...normalized,
        reportType: type,
        reportLabel: definition.label,
        reportId: `AMP-${type.slice(0, 3).toUpperCase()}-${fileIdentifier}-${date.replaceAll("-", "")}`,
        fileNameBase,
        fileName: `${fileNameBase}.pdf`,
        generatedAt,
        branch,
        preparedBy: `${branch} Branch`,
        systemName: "AEROPULSE",
        watermark: "AEROPULSE",
        unit: compactUnit,
      },
    });
  } catch (error) {
    console.error("Failed to generate AMP report:", error);
    return res.status(500).json({ message: "Unable to generate the AMP report right now." });
  }
};

module.exports = { getUnitHealthInsight, generateAmpReport };
