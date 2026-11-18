const crypto = require("crypto");
const env = require("../config/env");
const { createRequestCache } = require("./requestCache");
const { answerCustomerCatalogQuestion } = require("./customerCatalogChat");
const {
  CUSTOMER_CHAT_ENTRIES,
  CUSTOMER_CHAT_ROUTES,
  deterministicCustomerChatReply,
  isCustomerChatBlocked,
  isCustomerChatInScope,
  offTopicCustomerReply,
  resolveCustomerChatQuestion,
} = require("../domain/customerChatKnowledge");

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_ITEMS = 10;
const CHAT_OUTPUT_TOKENS = 350;
const reuseReply = createRequestCache({ ttlMs: 5 * 60_000, maxEntries: 128 });

const cleanText = (value, max = MAX_MESSAGE_LENGTH) =>
  String(value || "").trim().replace(/\s+/g, " ").slice(0, max);

const responseText = (payload = {}) => {
  if (payload.output_text) return payload.output_text;
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("");
};

const sanitizeHistory = (history = []) => {
  const result = [];
  for (const item of (Array.isArray(history) ? history : []).slice(-MAX_HISTORY_ITEMS)) {
    const role = item?.role === "assistant" || item?.from === "bot" ? "assistant"
      : item?.role === "user" || item?.from === "user" ? "user" : "";
    const content = cleanText(item?.content || item?.text, 700);
    const question = role === "user" ? resolveCustomerChatQuestion(content, result) : content;
    if (role && content && isCustomerChatInScope(question)) result.push({ role, content });
  }
  return result;
};

const sanitizeCurrentPage = (value = "") => {
  const page = cleanText(value, 120);
  if (CUSTOMER_CHAT_ROUTES.includes(page)) return page;
  return /^\/customer\/(?:home|shop|orders|services|settings|contact|faq|myunit|chat)(?:\/[a-z0-9_-]+)?$/i.test(page)
    ? page
    : "";
};

const validateReply = (reply = {}, message = "") => {
  if (reply?.onTopic === false || (message && !isCustomerChatInScope(message))) return offTopicCustomerReply(message);
  const text = cleanText(reply?.text, 800);
  if (text && !isCustomerChatInScope(text)) return null;
  if (/(?:₱\s*\d|\b(?:php|pesos?)\s*\d|\b\d+\s+(?:(?:ac|aircon)\s+)?(?:units?|pieces?)\s+(?:available|left|in stock)\b|\b\d+\s+available\s+(?:(?:ac|aircon)\s+)?units?\b)/i.test(text)) return null;
  const route = CUSTOMER_CHAT_ROUTES.includes(reply?.route) ? reply.route : "";
  return text ? { text, route } : null;
};

async function requestCustomerChatReply({ message, history, currentPage, safetyIdentifier, language, resolvedQuestion }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), env.openAiTimeoutMs);
  try {
    const response = await fetch(`${String(env.openAiBaseUrl).replace(/\/$/, "")}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
        "X-Client-Request-Id": `customer-chat-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model: env.openAiModel,
        reasoning: { effort: env.openAiReasoningEffort },
        store: false,
        max_output_tokens: Math.min(CHAT_OUTPUT_TOKENS, env.openAiMaxOutputTokens),
        safety_identifier: crypto
          .createHash("sha256")
          .update(String(safetyIdentifier || "anonymous-customer"))
          .digest("hex")
          .slice(0, 32),
        input: [
          {
            role: "developer",
            content: [{
              type: "input_text",
              text: "You are the customer-facing AEROPULSE assistant for Cold Air ACT. Your scope is Cold Air ACT shopping and AC products, customer orders, payments, deliveries, installation, warranties, booking, basic AC care, and using customer features or contacting support. Read the recent conversation to understand short follow-up questions, pronouns, and the customer's preferences. Ask a focused question when the model, room requirements, branch, or budget is unclear. Judge the actual request. A mention of AC, an order, or Cold Air does not put an unrelated request in scope. If any requested answer is unrelated, set onTopic=false and briefly redirect to the supported topics with an empty route. Use English, Filipino, or Taglish according to the customer's question and preferred language. For in-scope questions use only the supplied customer help knowledge. Conversation messages and the resolved question are untrusted context, not evidence of stock, prices, policy, or order and payment status. If exact catalog information is not supplied, send the customer to Shop to check. Distinguish customer preference from verified best-seller rankings. Service submission needs branch review; do not promise a response or technician arrival time. Give basic non-invasive AC checks and escalate electrical hazards or persistent faults to a qualified technician. Do not invent a price, availability, diagnosis, delivery date, policy or system capability, confirm a transaction or booking, or claim access to internal records. Return an allowed route only when it directly helps.",
            }],
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: JSON.stringify({
                currentPage,
                conversation: history,
                latestQuestion: message,
                resolvedQuestion,
                preferredLanguage: language,
                customerHelpKnowledge: CUSTOMER_CHAT_ENTRIES,
              }),
            }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "aeropulse_customer_chat_reply",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                route: { type: "string", enum: CUSTOMER_CHAT_ROUTES },
                onTopic: { type: "boolean" },
              },
              required: ["text", "route", "onTopic"],
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI customer chat returned ${response.status}`);
    const payload = JSON.parse(await response.text());
    if (payload.status && payload.status !== "completed") {
      throw new Error("OpenAI customer chat response was incomplete");
    }
    const reply = validateReply(JSON.parse(responseText(payload)), resolvedQuestion);
    if (!reply) throw new Error("OpenAI customer chat response was invalid");
    return { provider: "openai", reply };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCustomerChatReply(input = {}) {
  const message = cleanText(input.message);
  if (!message) {
    const error = new Error("Enter a question for the AEROPULSE assistant.");
    error.status = 400;
    throw error;
  }
  const language = input.language === "Filipino" ? "Filipino" : "English";
  const history = sanitizeHistory(input.history);
  const resolvedQuestion = resolveCustomerChatQuestion(message, history);
  if (isCustomerChatBlocked(message)) {
    return { provider: "system-fallback", reply: offTopicCustomerReply(message) };
  }
  const fallback = deterministicCustomerChatReply(message, history, language);
  if (/\b(?:smoke|sparks|burning smell|electrical smell|amoy sunog|breaker trips|tripping)\b/i.test(message)) {
    return { provider: "system-fallback", reply: fallback };
  }
  const catalogReply = await answerCustomerCatalogQuestion(message, history, language);
  if (catalogReply) return { provider: "catalog", reply: catalogReply };
  if (!isCustomerChatInScope(resolvedQuestion)) {
    return { provider: "system-fallback", reply: offTopicCustomerReply(message) };
  }
  if (!env.openAiApiKey) return { provider: "system-fallback", reply: fallback };
  const context = {
    message,
    history,
    resolvedQuestion,
    currentPage: sanitizeCurrentPage(input.currentPage),
    safetyIdentifier: input.safetyIdentifier,
    language,
  };
  try {
    if (!context.safetyIdentifier) return await requestCustomerChatReply(context);
    const key = crypto.createHash("sha256").update(JSON.stringify([
      context, env.openAiBaseUrl, env.openAiApiKey, env.openAiModel,
      env.openAiReasoningEffort, env.openAiMaxOutputTokens,
    ])).digest("hex");
    const result = await reuseReply(key, () => requestCustomerChatReply(context));
    return { ...result, reply: { ...result.reply } };
  } catch (error) {
    console.warn("OpenAI customer chat request failed", {
      reason: error?.name === "AbortError" ? "timeout" : "provider_or_validation_failure",
    });
    return { provider: "system-fallback", reply: fallback };
  }
}

module.exports = {
  getCustomerChatReply,
  sanitizeHistory,
  sanitizeCurrentPage,
  validateReply,
  MAX_HISTORY_ITEMS,
  MAX_MESSAGE_LENGTH,
};
