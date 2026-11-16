// Source for the web and mobile copies. Run node scripts/sync-contact-inquiry-validation.mjs after editing.
const SUBJECT_MAX_CHARACTERS = 160;
const SUBJECT_MAX_WORDS = 20;
const MESSAGE_MAX_CHARACTERS = 3000;
const MESSAGE_MAX_WORDS = 400;

const wordsOf = (text) => text.normalize("NFKC").replace(/\p{Cf}/gu, "")
  .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) || [];

const countInquiryWords = (text) => wordsOf(text).length;

const PLACEHOLDER = /^(?:lorem ipsum|dolor sit amet|consectetur adipiscing elit)\b|\blorem ipsum dolor sit amet\b|^(?:test(?:ing)?|sample|dummy|placeholder)(?: (?:only|message|text|data))?$/;

function isGibberishWord(word) {
  if (!/^[a-z]{5,}$/i.test(word)) return false;
  const repeated = word.match(/([a-z]{1,3})\1{3,}/i)?.[0] || "";
  return /^(?:asdf|qwerty|zxcv)/i.test(word)
    || repeated.length >= word.length / 2
    || (word !== word.toUpperCase() && /[b-df-hj-np-tv-z]{8,}/i.test(word));
}

function hasInquiryContent(words) {
  const normalized = words.map((word) => word.toLowerCase());
  if (PLACEHOLDER.test(normalized.join(" ").replace(/-/g, " "))) return false;
  if (words.length > 1 && new Set(normalized).size === 1) return false;
  for (let phraseLength = 2; phraseLength <= 4 && phraseLength * 4 <= words.length; phraseLength += 1) {
    if (normalized.every((word, index) => word === normalized[index % phraseLength])) return false;
  }
  return words.some((word) => /\p{L}/u.test(word) && !isGibberishWord(word));
}

// Return an English translation key so every surface shows the same reason.
function validateContactInquiry({ subject, message }) {
  if (typeof subject !== "string" || typeof message !== "string" || !subject.trim() || !message.trim()) {
    return "Subject and message are required.";
  }
  if (subject.length > SUBJECT_MAX_CHARACTERS) return "Subject must be 160 characters or fewer.";
  if (message.length > MESSAGE_MAX_CHARACTERS) return "Message must be 3000 characters or fewer.";
  if (subject.trim().length < 3) return "Subject must be at least 3 characters.";
  if (message.trim().length < 10) return "Please add a little more detail so the support team can help.";

  const subjectWords = wordsOf(subject);
  const messageWords = wordsOf(message);
  if (subjectWords.length > SUBJECT_MAX_WORDS) return "Subject must be 20 words or fewer.";
  if (messageWords.length > MESSAGE_MAX_WORDS) return "Message must be 400 words or fewer.";
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
  countInquiryWords,
  validateContactInquiry,
};
