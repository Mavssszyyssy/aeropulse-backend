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
    keywords: ["burning smell", "smoke", "sparks", "amoy sunog", "breaker trips", "tripping", "electrical smell"],
    answer: "Stop using the AC if there is smoke, a burning smell, sparking, or repeated breaker trips. Switch it off and isolate its power only if safe. Keep clear of wet wiring and request a qualified technician through Services. Avoid opening electrical panels or repeatedly resetting a breaker.",
    filipino: "Itigil ang paggamit ng aircon kung may usok, amoy sunog, spark, o paulit-ulit na pag-trip ng breaker. Patayin at ihiwalay ang power kung ligtas. Lumayo sa basang wiring at mag-request ng kwalipikadong technician sa Services. Iwasang buksan ang electrical panel o paulit-ulit na i-reset ang breaker.",
    route: "/services",
  },
  {
    keywords: ["respond", "response", "reply", "quickly", "how soon", "how long", "wait", "approval", "admin", "mabilis", "katagal", "sasagot", "tugon"],
    contextKeywords: ["service", "request", "technician", "maintenance", "repair", "booking", "appointment", "visit", "admin", "serbisyo"],
    answer: "After you submit a service request, the branch team reviews it and arranges the technician and schedule. Check its details in the mobile app's service history and watch your alerts for updates. Response time depends on the branch and technician availability. I do not have a confirmed response-time guarantee. Contact support with the request reference if you need an update.",
    filipino: "Kapag naipasa mo ang service request, susuriin ito ng branch at aayusin ang technician at iskedyul. Tingnan ang detalye sa service history ng mobile app at ang mga alerto para sa update. Depende sa branch at available na technician ang oras ng pagtugon. Wala akong kumpirmadong garantisadong oras ng sagot. Ibigay sa support ang request reference kung kailangan mo ng update.",
    route: "/services",
  },
  {
    keywords: ["not cooling", "insufficient cooling", "weak cooling", "hindi lumalamig", "mahina ang lamig", "walang lamig", "airflow", "aircon problem"],
    answer: "For weak cooling, check that the filter is clean and the thermostat and airflow are unobstructed. If cooling is still poor, turn the unit off if there is an electrical smell or water near wiring, then request a technician visit through Services. The cause needs inspection before any repair is confirmed.",
    filipino: "Para sa mahinang lamig, tiyaking malinis ang filter at walang nakaharang sa daloy ng hangin. Kung hindi pa rin lumalamig, mag-request ng technician sa Services. Patayin muna ang unit kung may amoy sunog o tubig malapit sa wiring. Kailangan ng inspeksyon bago matukoy ang sira.",
    route: "/services",
  },
  {
    keywords: ["water leaking", "leaking water", "water leak", "tumutulo", "tagas", "drain", "condensate"],
    answer: "If the AC leaks indoors, protect the surrounding area and switch it off if water is near electrical parts. A dirty filter, blocked drain, or installation issue can contribute, but a technician must inspect it to identify the cause. Avoid opening wiring or pouring chemicals into the drain. Request a visit in Services and include a photo of where the water appears.",
    filipino: "Kung tumutulo ang aircon sa loob, protektahan ang paligid at patayin ito kapag may tubig malapit sa electrical parts. Maaaring may kinalaman ang maruming filter, baradong drain, o installation, pero kailangan ng inspeksyon para matukoy ang dahilan. Iwasang buksan ang wiring o magbuhos ng kemikal sa drain. Mag-request sa Services at maglakip ng larawan ng tagas.",
    route: "/services",
  },
  {
    keywords: ["noise", "maingay", "rattling", "vibration", "vibrating", "grinding"],
    answer: "Check for loose objects around the AC and note when the sound happens. Switch the unit off if the noise is sudden, loud, or accompanied by a burning smell. Avoid reaching inside a fan or opening electrical parts. Share the model and a recording with a technician through Services so the cause can be inspected.",
    filipino: "Tingnan kung may maluwag na bagay sa paligid ng aircon at itala kung kailan lumalabas ang ingay. Patayin ang unit kung biglaan o malakas ang tunog, lalo na kung may amoy sunog. Huwag abutin ang fan o buksan ang electrical parts. Ibigay ang modelo at recording sa technician sa Services para ma-inspeksyon.",
    route: "/services",
  },
  {
    keywords: ["inverter vs", "inverter versus", "non inverter", "non-inverter", "inverter difference", "inverter at", "inverter o"],
    answer: "An inverter AC varies compressor speed to match cooling demand. A conventional non-inverter typically cycles the compressor on and off. Actual energy use depends on the unit's published efficiency, correct sizing, room conditions, settings, and use. Compare the listed model specifications and energy labels in Shop. Share your room size and budget to narrow the options.",
    filipino: "Inaangkop ng inverter aircon ang bilis ng compressor sa kailangan na lamig. Karaniwang naka-on o naka-off naman ang compressor ng non-inverter. Depende sa efficiency ng modelo, tamang sizing, kondisyon ng silid, setting, at paggamit ang konsumo. Ikumpara sa Shop ang specs at energy label. Ibigay ang laki ng silid at badyet para mapili ang mga opsyon.",
    route: "/shop",
  },
  {
    keywords: ["horsepower", "room size", "square meters", "sqm", "sukat ng", "laki ng", "ilang hp"],
    answer: "To choose AC capacity, share the room area, ceiling height, sun exposure, number of occupants, and heat-producing appliances. Room area alone cannot confirm the right horsepower. I can compare the catalog's listed capacities, and the branch technician can confirm sizing before installation.",
    filipino: "Para sa capacity ng aircon, ibigay ang lawak at taas ng silid, tama ng araw, dami ng tao, at mga appliance na naglalabas ng init. Hindi sapat ang sukat ng sahig lang para makumpirma ang tamang horsepower. Maaari kong ikumpara ang nakalistang capacity at makukumpirma ng technician ang sizing bago magkabit.",
    route: "/shop",
  },
  {
    keywords: ["shop", "buy", "product", "ac unit", "aircon", "brand", "price"],
    answer: "Open Shop to browse available AC units, compare products, and add an item to your cart.",
    filipino: "Buksan ang Shop para tingnan ang mga aircon, ikumpara ang mga produkto, at magdagdag sa cart.",
    route: "/shop",
  },
  {
    keywords: ["cart", "checkout", "quantity", "remove item", "delete item"],
    answer: "Use the cart in Shop or the order controls in Checkout to review items and change quantities before placing your order.",
    filipino: "Gamitin ang cart sa Shop o ang mga kontrol sa Checkout para suriin ang mga item at baguhin ang dami bago mag-order.",
    route: "/shop",
  },
  {
    keywords: ["gcash", "payment", "pay again", "failed", "cancelled", "retry"],
    answer: "Open My Orders and select Pay Again for an unpaid GCash order. You can make up to three payment attempts, and the order is marked paid only after GCash confirms payment.",
    filipino: "Buksan ang My Orders at piliin ang Pay Again para sa eligible na GCash order na hindi pa bayad. Hanggang tatlong payment attempt ang puwede. Mamarkahang bayad lang ang order kapag nakumpirma ang bayad.",
    route: "/my-orders",
  },
  {
    keywords: ["refund", "return", "ibalik", "reklamo"],
    answer: "For a concern about a purchase or possible refund, contact customer support with your order number and details. Sending a message does not automatically approve a refund or reverse a payment.",
    filipino: "Para sa concern sa binili o refund request, ibigay sa customer support ang order number at mga detalye. Kailangan ng pagsusuri bago maaprubahan ang refund o maibalik ang bayad.",
    route: "/contact",
  },
  {
    keywords: ["service", "book", "maintenance", "repair", "clean", "cleaning", "linis", "schedule", "warranty claim"],
    answer: "Open Services in the Cold Air mobile app to request cleaning, maintenance, repair, or warranty assistance and choose the AC unit that needs service.",
    filipino: "Buksan ang Services sa Cold Air mobile app at piliin ang aircon na nangangailangan ng cleaning, maintenance, repair, o warranty assistance. Pagkatapos, ilagay ang concern at ang hinihiling na iskedyul para masuri ng branch.",
    route: "/services",
  },
  {
    keywords: ["my unit", "add unit", "register unit", "qr", "warranty", "service history"],
    answer: "Open My Unit to view your registered AC units, warranty details, suggested service date, and recorded service history.",
    filipino: "Buksan ang My Unit para makita ang mga rehistradong aircon, detalye ng warranty, iminungkahing petsa ng serbisyo, at service history.",
    route: "/myunit",
  },
  {
    keywords: ["ai", "aeropulse", "suggested service", "prediction", "next cleaning"],
    answer: "AEROPULSE reviews verified cleaning history to suggest the next cleaning interval. When there is not enough verified history, it clearly shows the system baseline instead of presenting it as an AI prediction.",
    filipino: "Sinusuri ng AEROPULSE ang verified na cleaning history para magmungkahi ng susunod na cleaning interval. Kung kulang ang history, ipinapakita ang baseline ng system.",
    route: "/myunit",
  },
  {
    keywords: ["orders", "my orders", "track", "delivery", "invoice", "receipt"],
    answer: "Open My Orders to review payment, delivery, installation, and receipt information for your purchases.",
    filipino: "Buksan ang My Orders para makita ang impormasyon tungkol sa bayad, delivery, installation, at resibo. Para sa follow-up, ibigay ang order number sa support. Nakadepende sa branch at iskedyul ang kumpirmadong delivery at installation.",
    route: "/my-orders",
  },
  {
    keywords: ["settings", "profile", "password", "notification", "privacy"],
    answer: "Open Settings to update your customer profile, saved locations, password, notifications, and privacy preferences.",
    filipino: "Buksan ang Settings para baguhin ang profile, mga naka-save na address, password, notifications, at privacy preferences.",
    route: "/settings",
  },
  {
    keywords: ["contact", "support", "help", "office", "location", "hotline", "human"],
    answer: "Open Contact to send a support request or view Cold Air contact details.",
    filipino: "Buksan ang Contact para magpadala ng mensahe sa support o makita ang contact details ng Cold Air.",
    route: "/contact",
  },
  {
    keywords: ["faq", "questions", "common questions"],
    answer: "Open FAQ for quick guidance about orders, payments, AC care, warranty, and technician visits.",
    filipino: "Buksan ang FAQ para sa gabay tungkol sa order, bayad, pag-aalaga ng aircon, warranty, at pagbisita ng technician.",
    route: "/faq",
  },
];

const normalizeText = (value = "") => String(value || "")
  .normalize("NFKC")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .trim()
  .toLowerCase();

const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|kumusta|kamusta)[!. ]*$/i;
const CUSTOMER_TOPIC = /\b(?:aeropulse|cold\s*air(?:\s*(?:act|trading))?|air\s*con(?:ditioner|ditioning)?|aircon|a\/c|ac(?:\s*unit)?|cooling|airflow|thermostat|compressor|refrigerant|filter|leak|noise|shop|cart|checkout|orders?|purchases?|payment|paymongo|gcash|delivery|dispatch|install(?:ation|ing)?|technicians?|maintenance|repair|cleaning|warranty|service|support|contact|account|password|notifications?|refund|return|receipt|invoice|schedules?|bookings?|appointments?|service requests?|branch|stock|lamig|linis|sira|tagas|maingay|bayad|bili|tindahan|paghahatid|pagkakabit|garantiya|resibo|serbisyo|presyo|reklamo|retry)\b/i;
const INSTRUCTION_OVERRIDE = /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|the|your|previous|above|system|developer)\s+)*(?:instructions?|rules?|prompts?|restrictions?)\b|\b(?:act as|pretend (?:you are|to be)|role[ -]?play|you are now|developer mode|system (?:prompt|instruction|message)|jailbreak)\b|\b(?:kalimutan|balewalain|huwag sundin|wag sundin)\s+(?:(?:ang|lahat ng|mga)\s+)*(?:tagubilin|utos|panuntunan|instructions?)\b|\b(?:if you (?:don't|do not) (?:answer|comply|obey|give|tell|respond)|you will be punished|bad review unless)\b/i;
const UNRELATED_TOPIC = /\b(?:python|javascript|typescript|programming|programmer|coding|source code|(?:write|make|create|build) a program|essay|poem|story|joke|recipe|movie|celebrity|(?:football|basketball)\s+(?:score|game|team|player)|election|crypto|homework|video game|pizza|restaurant menu|capital of|weather forecast|stock (?:market|photos?|trading)|branch(?:es)? of (?:the )?government|(?:share|stock) prices? of)\b/i;

const isCustomerChatBlocked = (message) => {
  const normalized = normalizeText(message);
  return INSTRUCTION_OVERRIDE.test(normalized) || UNRELATED_TOPIC.test(normalized);
};

const isFilipinoQuestion = (message) => /\b(?:paano|pwede|puwede|ano|bakit|salamat|kamusta|tulong|magandang|saan|alin|anong|pinaka\w*|magkano|meron|mayroon|natitira|madami|marami|may|ng|sa)\b/i.test(message);

const isCustomerChatInScope = (message = "") => {
  const normalized = normalizeText(message);
  if (!normalized || isCustomerChatBlocked(normalized)) return false;
  return GREETING.test(normalized) || CUSTOMER_TOPIC.test(normalized)
    || /\b(?:buy|products?|models?|prices?|sku|inventory|sangay|katalogo|branches|inverter|horsepower|condensate|tumutulo|rattling|vibration)\b/.test(normalized)
    || /\bdeliver(?:s|ed)?\b/.test(normalized)
    || /\b(?:admin|branch)\b.*\b(?:response|respond|reply|approval|sasagot|tugon)\b/.test(normalized);
};

const contextualFollowUp = (message = "") => {
  const text = normalizeText(message);
  if (text.length > 200) return false;
  if (/\b(?:orders?|cart|checkout|payments?|refunds?|account|password|login|notifications?)\b/.test(text)) return false;
  if (!isCustomerChatInScope(text) && /^[\p{L}\p{N}][\p{L}\p{N}._-]*(?:[ -][\p{L}\p{N}._-]+){0,2}[?.!]?$/u.test(text)
    && !/^(?:who|what|where|when|tell|write|make|create|explain)\b/.test(text)) return true;
  return /^(?:(?:but|and|also|so|then|ok|okay|pero|at)\s+)*(?:for you\b|(?:which|what)\s+(?:one|is|about|would)\b|how\s+(?:about|long|soon|much)\b|why\b|is (?:it|that|this)\b|can (?:it|that|this)\b|does (?:it|that|this|submit|the admin)\b|(?:in|at|sa)\b|paano naman\b|alin\b|gaano\b|mabilis\b|magkano\b|under\s+[₱\d]|budget\b|\d+(?:\.\d+)?\s*(?:hp|sqm|sq\.?\s*m|square meters|pesos|k)\b)/i.test(text);
};

// Only customer turns establish a topic. History never supplies business facts.
const resolveCustomerChatQuestion = (message = "", history = []) => {
  let topic = "";
  for (const entry of (Array.isArray(history) ? history : []).slice(-10)) {
    if (!(entry?.role === "user" || entry?.from === "user")) continue;
    const text = String(entry.content || entry.text || "").trim().slice(0, 700);
    if (isCustomerChatBlocked(text)) { topic = ""; continue; }
    if (topic && contextualFollowUp(text)) topic = `${topic.slice(-700)}\n${text}`;
    else topic = isCustomerChatInScope(text) ? text : "";
  }
  const latest = String(message || "").trim();
  return topic && !isCustomerChatBlocked(latest) && contextualFollowUp(latest)
    ? `${topic.slice(-1000)}\n${latest}`
    : latest;
};

const offTopicCustomerReply = (message = "") => ({
  text: isFilipinoQuestion(message)
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

const deterministicCustomerChatReply = (message = "", history = [], language = "English") => {
  message = resolveCustomerChatQuestion(message, history);
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
  const latest = normalizeText(String(message).split("\n").at(-1));
  CUSTOMER_CHAT_ENTRIES.forEach((entry) => {
    if (entry.contextKeywords && !entry.contextKeywords.some((keyword) => normalized.includes(keyword))) return;
    const nextScore = entry.keywords.reduce(
      (total, keyword) => total + (latest.includes(keyword) ? keyword.length : 0),
      0,
    );
    if (nextScore > score) {
      best = entry;
      score = nextScore;
    }
  });

  // Electrical hazard guidance takes precedence over other symptoms.
  if (CUSTOMER_CHAT_ENTRIES[0].keywords.some((keyword) => normalized.includes(keyword))) best = CUSTOMER_CHAT_ENTRIES[0];
  if (!best && latest !== normalized) return deterministicCustomerChatReply(message.replaceAll("\n", " "), [], language);
  return best
    ? { text: best.filipino && (language === "Filipino" || isFilipinoQuestion(message)) ? best.filipino : best.answer, route: best.route }
    : inScopeSupportReply(message);
};

module.exports = {
  CUSTOMER_CHAT_ENTRIES,
  CUSTOMER_CHAT_ROUTES,
  deterministicCustomerChatReply,
  isCustomerChatBlocked,
  isCustomerChatInScope,
  isFilipinoQuestion,
  resolveCustomerChatQuestion,
  offTopicCustomerReply,
};
