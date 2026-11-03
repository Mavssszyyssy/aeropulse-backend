const SOURCE_LABELS = Object.freeze({
  social_media: "Social Media",
  paid_advertisement: "Paid Advertisement",
  friend_referral: "Referral",
  direct_organic: "Direct / Organic",
  walk_in: "Walk-in",
  google: "Google (recorded source)",
  other: "Other (recorded)",
  unknown: "Unknown / Not Tracked",
});

const cleanTrackingValue = (value) => typeof value === "string" && value.length <= 100
  ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  : "";

// Only explicit registration-link parameters establish an acquisition source.
// A visit without tracking is not evidence of an organic or advertising lead.
const acquisitionFromTracking = (tracking) => {
  if (!tracking || typeof tracking !== "object" || Array.isArray(tracking)) return "unknown";
  const source = cleanTrackingValue(tracking.utmSource);
  const medium = cleanTrackingValue(tracking.utmMedium);
  if (["cpc", "ppc", "paid", "paid_social", "paid_search", "display"].includes(medium)) return "paid_advertisement";
  if (["friend", "friend_referral", "referral"].includes(source) || medium === "referral") return "friend_referral";
  if (["facebook", "instagram", "tiktok", "youtube", "x", "twitter", "social_media"].includes(source)) return "social_media";
  if (source === "direct" || (source && medium === "organic")) return "direct_organic";
  if (source === "google") return "google";
  return "unknown";
};

const normalizeAcquisitionSource = (value) => {
  const source = cleanTrackingValue(value);
  return Object.hasOwn(SOURCE_LABELS, source) ? source : "unknown";
};

const summarizeAcquisitionRows = (rows = []) => {
  const counts = new Map();
  for (const row of rows) {
    const source = normalizeAcquisitionSource(row._id);
    counts.set(source, (counts.get(source) || 0) + Math.max(0, Number(row.count || 0)));
  }
  return Object.entries(SOURCE_LABELS)
    .map(([key, label]) => ({ key, label, count: counts.get(key) || 0 }))
    .filter((item) => item.count > 0);
};

module.exports = { SOURCE_LABELS, acquisitionFromTracking, normalizeAcquisitionSource, summarizeAcquisitionRows };
