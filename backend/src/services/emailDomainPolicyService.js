const mongoose = require("mongoose");
const EmailDomainPolicy = require("../models/EmailDomainPolicy");

const EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE =
  "This email domain is not allowed. Please use a valid and supported email provider.";
const EMAIL_FORMAT_MESSAGE = "Enter a valid email address.";

// Provider domains are the initial policy until Superadmin saves a managed
// policy. Custom company, organization, and school domains then use that same
// database-backed validation path.
const DEFAULT_ALLOWED_EMAIL_DOMAINS = Object.freeze([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.com.ph",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "aol.com",
  "zoho.com",
  "zohomail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
]);

// This list is intentionally independent from the editable whitelist. A known
// disposable provider cannot be enabled accidentally through System Settings.
const DISPOSABLE_EMAIL_DOMAINS = Object.freeze([
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "maildrop.cc",
  "mailinator.com",
  "mintemail.com",
  "moakt.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

const EMAIL_REGEX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DOMAIN_REGEX = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
const normalizeDomain = (value = "") => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/^@+/, "")
  .replace(/\.$/, "");

const isValidDomain = (value = "") => DOMAIN_REGEX.test(normalizeDomain(value));

const isValidEmailFormat = (value = "") => {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) return false;
  const [local] = email.split("@");
  return local.length <= 64
    && !local.startsWith(".")
    && !local.endsWith(".")
    && !local.includes("..");
};

const extractEmailDomain = (value = "") => {
  const email = normalizeEmail(value);
  if (!isValidEmailFormat(email)) return "";
  return normalizeDomain(email.slice(email.lastIndexOf("@") + 1));
};

const isDisposableEmailDomain = (value = "") => {
  const domain = normalizeDomain(value);
  return DISPOSABLE_EMAIL_DOMAINS.some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`),
  );
};

const defaultEntries = () => DEFAULT_ALLOWED_EMAIL_DOMAINS.map((domain) => ({
  domain,
  enabled: true,
  source: "default",
}));

let cachedPolicy = null;
let cacheExpiresAt = 0;
// Connected API instances read the shared policy on every validation so a
// Superadmin change is authoritative across serverless instances immediately.
// The cache remains useful only for the disconnected safe-default test path.
const CACHE_TTL_MS = 30_000;

const normalizeEntries = (entries = []) => {
  const byDomain = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const domain = normalizeDomain(typeof entry === "string" ? entry : entry?.domain);
    if (!isValidDomain(domain) || isDisposableEmailDomain(domain)) continue;
    byDomain.set(domain, {
      domain,
      enabled: typeof entry === "string" ? true : entry.enabled !== false,
      source: DEFAULT_ALLOWED_EMAIL_DOMAINS.includes(domain) ? "default" : "custom",
    });
  }
  return Array.from(byDomain.values()).sort((left, right) => left.domain.localeCompare(right.domain));
};

const getEmailDomainPolicy = async ({ fresh = false } = {}) => {
  const now = Date.now();
  if (
    mongoose.connection.readyState !== 1
    && !fresh
    && cachedPolicy
    && cacheExpiresAt > now
  ) return cachedPolicy;

  let entries = defaultEntries();
  if (mongoose.connection.readyState === 1) {
    try {
      const stored = await EmailDomainPolicy.findOne({ key: "global" }).lean();
      if (stored?.domains?.length) entries = normalizeEntries(stored.domains);
    } catch (error) {
      console.error("Unable to load email-domain policy:", error.message);
      throw error;
    }
  }

  cachedPolicy = {
    domains: entries,
    activeDomains: entries.filter((entry) => entry.enabled).map((entry) => entry.domain),
  };
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedPolicy;
};

const validateEmailAddress = async (value = "") => {
  const email = normalizeEmail(value);
  if (!isValidEmailFormat(email)) {
    return { ok: false, code: "invalid_format", message: EMAIL_FORMAT_MESSAGE, email, domain: "" };
  }
  const domain = extractEmailDomain(email);
  if (isDisposableEmailDomain(domain)) {
    return { ok: false, code: "disposable_domain", message: EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE, email, domain };
  }
  const policy = await getEmailDomainPolicy();
  if (!policy.activeDomains.includes(domain)) {
    return { ok: false, code: "unsupported_domain", message: EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE, email, domain };
  }
  return { ok: true, code: "allowed", message: "", email, domain };
};

const saveEmailDomainPolicy = async (entries = [], updatedBy = null) => {
  const domains = normalizeEntries(entries);
  if (!domains.length) {
    const error = new Error("Add at least one valid email domain before saving.");
    error.status = 400;
    throw error;
  }
  if (!domains.some((entry) => entry.enabled)) {
    const error = new Error("Enable at least one email domain before saving.");
    error.status = 400;
    throw error;
  }
  if (domains.length > 250) {
    const error = new Error("A maximum of 250 email domains can be configured.");
    error.status = 400;
    throw error;
  }

  const policy = await EmailDomainPolicy.findOneAndUpdate(
    { key: "global" },
    { $set: { domains, updatedBy: updatedBy || null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  cachedPolicy = null;
  cacheExpiresAt = 0;
  return {
    domains: normalizeEntries(policy.domains),
    activeDomains: normalizeEntries(policy.domains)
      .filter((entry) => entry.enabled)
      .map((entry) => entry.domain),
  };
};

const clearEmailDomainPolicyCache = () => {
  cachedPolicy = null;
  cacheExpiresAt = 0;
};

module.exports = {
  DEFAULT_ALLOWED_EMAIL_DOMAINS,
  DISPOSABLE_EMAIL_DOMAINS,
  EMAIL_DOMAIN_NOT_ALLOWED_MESSAGE,
  EMAIL_FORMAT_MESSAGE,
  clearEmailDomainPolicyCache,
  extractEmailDomain,
  getEmailDomainPolicy,
  isDisposableEmailDomain,
  isValidDomain,
  isValidEmailFormat,
  normalizeDomain,
  normalizeEmail,
  saveEmailDomainPolicy,
  validateEmailAddress,
};
