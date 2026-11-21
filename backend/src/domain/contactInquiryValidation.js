// Source for the web and mobile copies. Run node scripts/sync-contact-inquiry-validation.mjs after editing.
const SUBJECT_MAX_CHARACTERS = 80;
const SUBJECT_MAX_WORDS = 12;
const MESSAGE_MAX_CHARACTERS = 1000;
const MESSAGE_MAX_WORDS = 150;
const CONTACT_NAME_MAX_CHARACTERS = 60;

const wordsOf = (text) => text.normalize("NFKC").replace(/\p{Cf}/gu, "")
  .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) || [];

const countInquiryWords = (text) => wordsOf(text).length;

const PLACEHOLDER = /^(?:lorem ipsum|dolor sit amet|consectetur adipiscing elit)\b|\blorem ipsum dolor sit amet\b|^(?:test(?:ing)?|sample|dummy|placeholder)(?: (?:only|message|text|data))?$/;

function isGibberishWord(word) {
  // Model/order identifiers and non-Latin words are not checked as English words.
  // These rules detect mechanical patterns, not dictionary membership.
  if (/([a-z])\1{4,}/i.test(word)) return true;
  const repeated = word.match(/([a-z]{1,3})\1{2,}/i)?.[0] || "";
  if (repeated.length >= 6 && repeated.length >= word.length * 0.6) return true;
  if (/[0-9]/.test(word) || !/^[a-z'-]+$/i.test(word)) return false;
  if (/[-']/.test(word)) return word.split(/[-']/).every(isGibberishWord);
  return /^(?:asdf|qwerty|zxcv)/i.test(word)
    || /[b-df-hj-np-tv-z]{7,}/i.test(word)
    || (word.length >= 5 && !/[aeiouy]/i.test(word) && !(word.length <= 6 && word === word.toUpperCase()));
}

function hasInquiryContent(words) {
  const normalized = words.map((word) => word.toLowerCase());
  if (normalized.some((word) => /([a-z])\1{4,}/.test(word))) return false;
  if (PLACEHOLDER.test(normalized.join(" ").replace(/-/g, " "))) return false;
  if (words.length > 1 && new Set(normalized).size === 1) return false;
  // Catch repeated filler even when a real word is appended to bypass validation.
  for (let size = 1; size <= 12; size += 1) {
    for (let start = 0; start + size * 4 <= words.length; start += 1) {
      let end = start + size;
      while (end < words.length && normalized[end] === normalized[start + (end - start) % size]) end += 1;
      if (end - start >= size * 4 && end - start >= words.length * 0.6) return false;
    }
  }
  const lexicalWords = words.filter((word) => /\p{L}/u.test(word));
  const junkWords = lexicalWords.filter(isGibberishWord);
  return lexicalWords.some((word) => /\p{L}[\p{L}\p{M}]/u.test(word) && !isGibberishWord(word))
    && junkWords.length < Math.ceil(lexicalWords.length / 3);
}

function validateContactName(value) {
  if (typeof value !== "string" || !value.trim()) return "Your name is required.";
  if (value.length > CONTACT_NAME_MAX_CHARACTERS) return "Name must be 60 characters or fewer.";
  const text = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const namePart = /^[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}]+)*\.?$/u;
  if (!text.split(" ").every((part) => namePart.test(part)) || !hasInquiryContent(wordsOf(text))) {
    return "Enter your name using letters, spaces, apostrophes, periods, or hyphens. Avoid repeated or placeholder text.";
  }
  return "";
}

function validateContactReply(reply) {
  if (typeof reply !== "string" || !reply.trim()) return "Write a reply before sending it to the customer.";
  if (reply.length > MESSAGE_MAX_CHARACTERS) return "Reply must be 1000 characters or fewer.";
  const words = wordsOf(reply);
  if (words.length > MESSAGE_MAX_WORDS) return "Reply must be 150 words or fewer.";
  if (words.length < 2 || !hasInquiryContent(words)) {
    return "Write a clear reply with at least two words. Avoid placeholder, random, or repeated text.";
  }
  return "";
}

// Return an English translation key so every surface shows the same reason.
function validateContactInquiry({ subject, message }) {
  if (typeof subject !== "string" || typeof message !== "string" || !subject.trim() || !message.trim()) {
    return "Subject and message are required.";
  }
  if (subject.length > SUBJECT_MAX_CHARACTERS) return "Subject must be 80 characters or fewer.";
  if (message.length > MESSAGE_MAX_CHARACTERS) return "Message must be 1000 characters or fewer.";
  if (subject.trim().length < 3) return "Subject must be at least 3 characters.";
  if (message.trim().length < 10) return "Please add a little more detail so the support team can help.";

  const subjectWords = wordsOf(subject);
  const messageWords = wordsOf(message);
  if (subjectWords.length > SUBJECT_MAX_WORDS) return "Subject must be 12 words or fewer.";
  if (messageWords.length > MESSAGE_MAX_WORDS) return "Message must be 150 words or fewer.";
  if (!hasInquiryContent(subjectWords)) return "Enter a clear subject about your concern. Avoid placeholder or repeated text.";
  if (!hasInquiryContent(messageWords)) return "Describe your concern in the message. Avoid placeholder or repeated text.";
  if (messageWords.length < 2) return "Please add a little more detail so the support team can help.";
  return "";
}

module.exports = {
  SUBJECT_MAX_CHARACTERS,
  SUBJECT_MAX_WORDS,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_MAX_WORDS,
  CONTACT_NAME_MAX_CHARACTERS,
  countInquiryWords,
  validateContactInquiry,
  validateContactReply,
  validateContactName,
};
