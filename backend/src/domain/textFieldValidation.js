// Shared with web/mobile by scripts/sync-text-field-validation.mjs.
// Human text is checked by field purpose. Credentials, searches, identifiers,
// measured values, enums, URLs and uploaded evidence are never spell-checked.
const TEXT_API_ROOTS = ["auth", "users", "system-settings", "dashboard", "products", "reorders", "service-requests", "orders", "notifications", "tasks", "inventory-change-requests", "restock-orders", "reports", "ai", "amp", "predictions", "parts-requests", "warranties", "branches", "contact-messages"];
const COMMON_TEXT_FIELDS = {
  title: [160, "Title", "label"], description: [1000, "Description", "note"],
  notes: [1000, "Notes", "note"], note: [1000, "Note", "note"],
  reason: [1000, "Reason", "note"], rejectionReason: [1000, "Rejection reason", "note"],
  cancellationReason: [500, "Cancellation reason", "note"], reviewNote: [1000, "Review note", "note"],
  reviewNotes: [1000, "Review notes", "note"], decisionNote: [500, "Decision note", "note"],
  concern: [1000, "Service concern", "note"], issueDescription: [500, "Service concern", "note"],
  other: [1000, "Additional details", "note"], otherIssue: [1000, "Additional details", "note"],
  otherDescription: [1000, "Additional details", "note"], additionalNotes: [1000, "Additional notes", "note"],
  findings: [1500, "Findings", "note"], resolution: [1500, "Work performed", "note"],
  actionTaken: [1500, "Work performed", "note"], serviceActions: [2500, "Service actions", "note"],
  beforeCondition: [1000, "Before condition", "note"], afterCondition: [1000, "After condition", "note"],
  proofNotes: [1500, "Proof notes", "note"], proof_notes: [1500, "Proof notes", "note"],
  customerAdvice: [1000, "Customer advice", "note"], completionNotes: [1000, "Completion notes", "note"],
  failureReason: [500, "Failure reason", "note"], rescheduleReason: [500, "Reschedule reason", "note"],
  holdReason: [500, "Hold reason", "note"], defectReason: [500, "Defect reason", "note"],
  delivery_instructions: [1000, "Delivery instructions", "note"], deliveryInstructions: [1000, "Delivery instructions", "note"],
  instructions: [1000, "Instructions", "note"], customerNotes: [1000, "Customer notes", "note"],
  requestNotes: [1000, "Request notes", "note"], remarks: [1000, "Remarks", "note"],
  summary: [1000, "Summary", "note"], unitName: [120, "Unit name", "label"],
  customerAddress: [240, "Customer address", "address"],
  signatureName: [60, "Signature name", "person"], customerSignatureName: [60, "Signature name", "person"],
  landmark: [180, "Landmark", "address"], street: [180, "Street address", "address"],
  thoroughfare: [180, "Street address", "address"], address: [240, "Address", "address"],
  property_block_lot: [80, "Property, block, or lot", "identifier"], apartment_unit: [80, "Apartment unit", "identifier"],
  label: [80, "Label", "label"], partName: [120, "Part name", "label"], partsUsed: [1500, "Parts used", "label"],
  sku: [80, "SKU", "identifier"], specs: [80, "Specs", "identifier"], model: [80, "Model", "identifier"],
  name_first: [20, "First name", "person"], name_last: [20, "Last name", "person"],
  firstName: [20, "First name", "person"], lastName: [20, "Last name", "person"],
  customerName: [60, "Customer name", "person"], recipientName: [60, "Recipient name", "person"],
  contactName: [60, "Contact name", "person"], supplierName: [120, "Supplier name", "label"],
  region: [100, "Region", "location"], province: [100, "Province", "location"],
  city: [100, "City or municipality", "location"], barangay: [100, "Barangay", "location"],
  municipality: [100, "City or municipality", "location"], submunicipality: [100, "Barangay", "location"],
};
const TECHNICAL_WORDS = new Set(["ac", "a/c", "hvac", "pcb", "txv", "eev", "ecm", "psc", "rpm", "cfm", "btu", "hp", "psi", "diy", "qr", "sku", "cod", "gcash", "ncr", "bgc", "ph", "st", "rd", "dr", "brgy", "bldg", "blk", "rm", "ng", "mga", "lg", "tcl", "vrf", "vrv", "ahu", "fcu", "bms", "vfd", "ddc", "dx", "rla", "lra"]);
const SHORT_NAMES = new Set(["ng", "sy", "dy", "uy", "ty", "ly", "my", "vy", "jr", "sr"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "phd", "edd", "md", "do", "dds", "dmd", "dvm", "rn", "cpa", "esq", "jd", "pe", "engr", "ree", "rme", "mba", "msc"]);
const wordTokens = (text) => text.normalize("NFKC").replace(/\p{Cf}/gu, "").match(/[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*/gu) || [];

function mechanicalWord(word, kind) {
  if (!/^[a-z0-9’'/-]+$/i.test(word)) return false;
  const lower = word.toLowerCase();
  if (/([a-z])\1{3,}/i.test(word) || /^(?:asdf|qwer|zxcv|qazwsx|poiuy)|^(?:asd|sdf|jhj|shs|hsh|qwe|qaz){2,}$/i.test(word)) return true;
  const repeat = lower.match(/([a-z]{1,3})\1{2,}/)?.[0] || "";
  if (repeat.length >= 6 && repeat.length >= word.length * .6) return true;
  if (/\d/.test(word)) return false; // Model numbers and measured readings.
  if (TECHNICAL_WORDS.has(lower) && kind !== "person") return false;
  if (["label", "address"].includes(kind) && /^[A-Z]{2,5}$/.test(word)) return false; // Brands, buildings and named components can be acronyms.
  if (kind === "person" && SHORT_NAMES.has(lower)) return false;
  if (/[’'/-]/.test(word)) return word.split(/[’'/-]/).some((part) => mechanicalWord(part, kind));
  return /[b-df-hj-np-tv-z]{6,}/i.test(word)
    || (word.length >= 2 && !/[aeiouy]/i.test(word) && !(kind === "person" && word.length === 1));
}

function validateHumanText(value, { max = 1000, label = "Text", kind = "note", maxWords = kind === "person" ? 12 : Math.ceil(max * .15) } = {}) {
  if (value === undefined || value === null || value === "") return ""; // Requiredness belongs to the owning form/domain.
  if (typeof value !== "string") return `${label} must be text.`;
  if (value.length > max) return `${label} must be ${max} characters or fewer.`;
  const text = value.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
  if (!text) return `${label}: enter meaningful text.`;
  if (kind === "identifier") return /^[\p{L}\p{M}\p{N} .,_/'’:+#()\-]+$/u.test(text) ? "" : `${label}: enter a valid unit, model, or reference value.`;
  const words = wordTokens(text);
  if (words.length > maxWords) return `${label} must be ${maxWords} words or fewer.`;
  const invalid = () => `${label}: enter meaningful text. Avoid random letters, placeholders, or repeated text.`;
  if (kind === "person") {
    if (text.length < 2 || !text.split(/\s+/).every((part) => /^[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}]+)*\.?$/u.test(part))) return invalid();
  }
  if (/^(?:lorem[ -]+ipsum|dolor sit amet|consectetur adipiscing)|^(?:test(?:ing)?|dummy|sample|placeholder)(?:\s+(?:only|text|name|message|data))*[.!]?$/i.test(text)) return invalid();
  if (/([\p{L}])\1{3,}/iu.test(text)) return invalid();
  const normalized = words.map((word) => word.toLowerCase());
  for (let size = 1; size <= 12; size += 1) {
    for (let start = 0; start + size * 3 <= words.length; start += 1) {
      let end = start + size;
      while (end < words.length && normalized[end] === normalized[start + (end - start) % size]) end += 1;
      if (end - start >= size * 3 && end - start >= words.length * .6) return invalid();
    }
  }
  const lexical = words.filter((word) => /\p{L}/u.test(word));
  if (kind === "person" && /^\p{L}\.(?:\s+\p{L}\.)*$/u.test(text)) return "";
  // Apartments, lots and individual part numbers can be numeric. A narrative,
  // person or geographic location must contain meaningful letters.
  if (!lexical.length) return ["address", "identifier"].includes(kind) && words.length ? "" : invalid();
  const junk = lexical.filter((word) => mechanicalWord(word, kind));
  if (junk.length >= Math.ceil(lexical.length / 3)) return invalid();
  if (!lexical.some((word) => (/\p{L}[\p{L}\p{M}]/u.test(word) || (kind !== "person" && /\p{L}/u.test(word) && /\d/.test(word))) && !mechanicalWord(word, kind))) return invalid();
  return "";
}

function textPolicyFor(key, { root, parent = "", route = "" } = {}) {
  if (key === "suffix") return [12, "Suffix", "suffix"];
  if (key === "name") return /address|recipient|customer/i.test(parent) ? [60, "Recipient name", "person"] : root === "branches" ? [80, "Branch name", "label"]
    : root === "products" || parent === "supplier" ? [120, parent === "supplier" ? "Supplier name" : "Product name", "label"]
      : ["users", "auth", "contact-messages"].includes(root) ? [60, "Name", "person"] : [120, "Name", "label"];
  if (key === "brand") return [80, "Brand", "label"];
  if (key === "features") return [1000, "Product features", "note"];
  if (key === "contact" && parent === "supplier") return [120, "Supplier contact", "person"];
  if (key === "subject" && root === "contact-messages") return [80, "Subject", "label", 12];
  if (key === "adminReply") return [1000, "Reply", "note", 150];
  if (key === "message" && root === "contact-messages") return [1000, "Message", "note", 150];
  if (key === "message" && root === "ai" && /customer-chat/.test(route)) return [1000, "Question", "note", 150];
  if (key === "notes" && root === "service-requests") return [2000, "Notes", "note", 300];
  if (root === "products" && key === "description") return [2000, "Product description", "note", 300];
  if (root === "warranties" && key === "notes") return [500, "Notes", "note", 75];
  if (root === "orders" && key === "reason" && /cancel/.test(route)) return [500, "Cancellation reason", "note", 75];
  return Object.prototype.hasOwnProperty.call(COMMON_TEXT_FIELDS, key) ? COMMON_TEXT_FIELDS[key] : undefined;
}

function validateTextRequest(route, method, body, { validateLocation } = {}) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase()) || !body || typeof body !== "object") return null;
  const pathname = String(route).split("?")[0].replace(/^https?:\/\/[^/]+/i, "").replace(/^\/api(?=\/)/, "");
  const root = pathname.split("/").filter(Boolean)[0];
  if (!TEXT_API_ROOTS.includes(root) || /\/webhooks?(?:\/|$)/i.test(pathname) || pathname === "/auth/session/cart") return null;
  function visit(value, parts = []) {
    if (!value || typeof value !== "object") return null;
    if (parts.length > 12) return { field: parts.join("."), message: "The submitted details are nested too deeply." };
    for (const [key, entry] of Object.entries(value)) {
      const field = [...parts, key].join(".");
      // Immutable historical log entries are checked against the saved log by
      // changedServiceLogTextError. Chat history is context, not a new message.
      if (["serviceLogs", "timeline", "history", "messages", "photo", "photos", "beforePhotos", "afterPhotos", "attachments", "files", "images"].includes(key)) continue;
      if (root === "branches" && key === "coverageAreas") {
        const areas = typeof entry === "string" ? entry.split(",") : entry;
        if (!Array.isArray(areas) || !areas.length || areas.length > 100 || areas.some((area) => typeof area !== "string" || !area.trim())) return { field, message: "Separate every service area with a comma; remove empty entries." };
        if (areas.join(",").length > 2000) return { field, message: "Service areas must be 2000 characters or fewer." };
        for (const area of areas) {
          const message = validateHumanText(area, { max: 80, label: "Service area", kind: "location" });
          if (message) return { field, message };
          if (validateLocation && !validateLocation(area)) return { field, message: "Enter a recognized region, province, city, municipality, or barangay as each service area." };
        }
        continue;
      }
      const policy = textPolicyFor(key, { root, parent: parts.at(-1), route: pathname });
      if (policy && entry && typeof entry === "object" && !Array.isArray(entry) && key !== "address") return { field, message: `${policy[1]} must be text.` };
      if (policy && (typeof entry !== "object" || entry === null || Array.isArray(entry))) {
        const [max, label, kind, maxWords] = policy;
        if (Array.isArray(entry) && !["features", "serviceActions", "partsUsed"].includes(key)) return { field, message: `${label} must be text.` };
        const values = Array.isArray(entry) ? entry : [entry];
        if (Array.isArray(entry) && values.some((item) => typeof item !== "string")) return { field, message: `${label} must contain text entries.` };
        if (values.length > 100) return { field, message: `${label} contains too many entries.` };
        if (Array.isArray(entry) && values.every((item) => typeof item === "string") && values.join(",").length > max) return { field, message: `${label} must be ${max} characters or fewer.` };
        for (const item of values) {
          if (kind === "suffix" && item != null && typeof item !== "string") return { field, message: "Suffix must be text." };
          const message = kind === "suffix" ? (item && (item.length > max || !/^[A-Za-z. ]+$/.test(item) || !NAME_SUFFIXES.has(item.replace(/[. ]/g, "").toLowerCase())) ? "Choose a valid suffix, such as Jr., Sr., II, or III." : "")
            : validateHumanText(item, { max, label, kind, ...(maxWords ? { maxWords } : {}) });
          if (message) return { field, message };
          if (kind === "location" && key !== "name" && typeof item === "string" && item.trim() && validateLocation && !validateLocation(item)) return { field, message: `${label}: choose a recognized Philippine location.` };
        }
        if (Array.isArray(entry) && new Set(values.map((item) => item.trim().toLowerCase())).size !== values.length) return { field, message: `${label}: remove duplicate entries.` };
      } else if (entry && typeof entry === "object") {
        const error = visit(entry, [...parts, key]);
        if (error) return error;
      }
    }
    return null;
  }
  return visit(body);
}

module.exports = { TEXT_API_ROOTS, COMMON_TEXT_FIELDS, validateHumanText, validateTextRequest, textPolicyFor };
