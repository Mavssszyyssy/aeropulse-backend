const CUSTOMER_CHAT_ROUTES = [
  "",
  "/shop",
  "/services",
  "/myunit",
  "/my-orders",
  "/settings",
  "/contact",
  "/faq",
];

const CUSTOMER_CHAT_ENTRIES = [
  {
    keywords: ["not cooling", "insufficient cooling", "weak cooling", "hindi lumalamig", "mahina ang lamig", "walang lamig", "airflow", "tagas", "leak", "maingay", "noise", "aircon problem"],
    answer: "For weak cooling, check that the filter is clean and the thermostat and airflow are unobstructed. If cooling is still poor, turn the unit off if there is an electrical smell or water near wiring, then request a technician visit through Services. The cause needs inspection before any repair is confirmed.",
    route: "/services",
  },
  {
    keywords: ["shop", "buy", "product", "ac unit", "aircon", "brand", "price"],
    answer: "Open Shop to browse available AC units, compare products, and add an item to your cart.",
    route: "/shop",
  },
  {
    keywords: ["cart", "checkout", "quantity", "remove item", "delete item"],
    answer: "Use the cart in Shop or the order controls in Checkout to review items and change quantities before placing your order.",
    route: "/shop",
  },
  {
    keywords: ["gcash", "payment", "pay again", "failed", "cancelled", "retry"],
    answer: "Open My Orders and select Pay Again for an unpaid GCash order. You can make up to three payment attempts, and the order is marked paid only after GCash confirms payment.",
    route: "/my-orders",
  },
  {
    keywords: ["refund", "return", "ibalik", "reklamo"],
    answer: "For a concern about a purchase or possible refund, contact customer support with your order number and details. Sending a message does not automatically approve a refund or reverse a payment.",
    route: "/contact",
  },
  {
    keywords: ["service", "book", "maintenance", "repair", "clean", "cleaning", "linis", "schedule", "warranty claim"],
    answer: "Open Services in the Cold Air mobile app to request cleaning, maintenance, repair, or warranty assistance and choose the AC unit that needs service.",
    route: "/services",
  },
  {
    keywords: ["my unit", "add unit", "register unit", "qr", "warranty", "service history"],
    answer: "Open My Unit to view your registered AC units, warranty details, suggested service date, and recorded service history.",
    route: "/myunit",
  },
  {
    keywords: ["ai", "aeropulse", "suggested service", "prediction", "next cleaning"],
    answer: "AEROPULSE reviews verified cleaning history to suggest the next cleaning interval. When there is not enough verified history, it clearly shows the system baseline instead of presenting it as an AI prediction.",
    route: "/myunit",
  },
  {
    keywords: ["orders", "my orders", "track", "delivery", "invoice", "receipt"],
    answer: "Open My Orders to review payment, delivery, installation, and receipt information for your purchases.",
    route: "/my-orders",
  },
  {
    keywords: ["settings", "profile", "password", "notification", "privacy"],
    answer: "Open Settings to update your customer profile, saved locations, password, notifications, and privacy preferences.",
    route: "/settings",
  },
  {
    keywords: ["contact", "support", "help", "office", "location", "hotline", "human"],
    answer: "Open Contact to send a support request or view Cold Air contact details.",
    route: "/contact",
  },
  {
    keywords: ["faq", "questions", "common questions"],
    answer: "Open FAQ for quick guidance about orders, payments, AC care, warranty, and technician visits.",
    route: "/faq",
  },
];

const normalizeText = (value = "") => String(value || "")
  .normalize("NFKC")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .trim()
  .toLowerCase();

const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|kumusta|kamusta)[!. ]*$/i;
const CUSTOMER_TOPIC = /\b(?:aeropulse|cold\s*air(?:\s*(?:act|trading))?|air\s*con(?:ditioner|ditioning)?|aircon|a\/c|ac(?:\s*unit)?|cooling|airflow|thermostat|compressor|refrigerant|filter|leak|noise|shop|cart|checkout|orders?|purchases?|payment|paymongo|gcash|delivery|dispatch|install(?:ation|ing)?|technician|maintenance|repair|cleaning|warranty|service|support|contact|account|password|notifications?|refund|return|receipt|invoice|schedule|booking|branch|stock|lamig|linis|sira|tagas|maingay|bayad|bili|tindahan|paghahatid|pagkakabit|garantiya|resibo|serbisyo|presyo|reklamo|retry)\b/i;
const INSTRUCTION_OVERRIDE = /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|the|your|previous|above|system|developer)\s+)*(?:instructions?|rules?|prompts?|restrictions?)\b|\b(?:act as|pretend (?:you are|to be)|role[ -]?play|you are now|developer mode|system (?:prompt|instruction|message)|jailbreak)\b|\b(?:kalimutan|balewalain|huwag sundin|wag sundin)\s+(?:(?:ang|lahat ng|mga)\s+)*(?:tagubilin|utos|panuntunan|instructions?)\b|\b(?:if you (?:don't|do not) (?:answer|comply|obey|give|tell|respond)|you will be punished|bad review unless)\b/i;
const UNRELATED_TOPIC = /\b(?:python|javascript|typescript|programming|programmer|coding|source code|(?:write|make|create|build) a program|essay|poem|story|joke|recipe|movie|celebrity|(?:football|basketball)\s+(?:score|game|team|player)|election|crypto|homework|video game|pizza|restaurant menu|capital of|weather forecast|stock market)\b/i;

const isCustomerChatInScope = (message = "") => {
  const normalized = normalizeText(message);
  if (!normalized || INSTRUCTION_OVERRIDE.test(normalized) || UNRELATED_TOPIC.test(normalized)) return false;
  return GREETING.test(normalized) || CUSTOMER_TOPIC.test(normalized);
};

const offTopicCustomerReply = (message = "") => ({
  text: /\b(paano|pwede|puwede|ano|bakit|salamat|kamusta|tulong|magandang)\b/i.test(message)
    ? "Para sa mga tanong tungkol sa AEROPULSE, aircon, order, delivery, at serbisyo ng Cold Air ang assistant na ito. Paano kita matutulungan sa mga ito?"
    : "I can help with AEROPULSE, air conditioners, orders, delivery, and Cold Air services. What would you like to know about those?",
  route: "",
});

const inScopeSupportReply = (message = "") => ({
  text: /\b(paano|pwede|puwede|ano|bakit|tulong|ko|akin)\b/i.test(message)
    ? "Para sa tanong na ito tungkol sa aircon o serbisyo ng Cold Air, makipag-ugnayan sa customer support para sa tamang gabay."
    : "For this AC or Cold Air service question, please contact customer support for the right guidance.",
  route: "/contact",
});

const deterministicCustomerChatReply = (message = "") => {
  const normalized = normalizeText(message);
  if (!normalized) return null;
  if (!isCustomerChatInScope(normalized)) return offTopicCustomerReply(message);
  if (GREETING.test(normalized)) {
    return {
      text: /^(?:kumusta|kamusta)/i.test(normalized)
        ? "Kumusta! Paano kita matutulungan sa order, bayad, aircon, o serbisyo?"
        : "Hello! How can I help with your order, payment, AC unit, or service request?",
      route: "",
    };
  }

  let best = null;
  let score = 0;
  CUSTOMER_CHAT_ENTRIES.forEach((entry) => {
    const nextScore = entry.keywords.reduce(
      (total, keyword) => total + (normalized.includes(keyword) ? keyword.length : 0),
      0,
    );
    if (nextScore > score) {
      best = entry;
      score = nextScore;
    }
  });

  return best
    ? { text: best === CUSTOMER_CHAT_ENTRIES[0] && /hindi lumalamig|mahina ang lamig|walang lamig|tagas|maingay/i.test(normalized)
      ? "Para sa mahinang lamig, tiyaking malinis ang filter at walang nakaharang sa daloy ng hangin. Kung hindi pa rin lumalamig, mag-request ng technician sa Services. Patayin muna ang unit kung may amoy sunog o tubig malapit sa wiring. Kailangan ng inspeksyon bago matukoy ang sira."
      : best.answer, route: best.route }
    : inScopeSupportReply(message);
};

module.exports = {
  CUSTOMER_CHAT_ENTRIES,
  CUSTOMER_CHAT_ROUTES,
  deterministicCustomerChatReply,
  isCustomerChatInScope,
  offTopicCustomerReply,
};
