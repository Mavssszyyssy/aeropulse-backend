const FALLBACK_SERVICE_CATALOG = [
  { id: "delivery", title: "Delivery", summary: "Track AC unit delivery and coordinate the required hand-off.", defaultIssueType: "Delivery" },
  { id: "installation", title: "Installation", summary: "Schedule installation for a registered AC unit.", defaultIssueType: "Installation" },
  { id: "maintenance", title: "Maintenance", summary: "Schedule preventive maintenance to keep the AC unit efficient.", defaultIssueType: "Maintenance" },
  { id: "cleaning", title: "Cleaning", summary: "Book deep cleaning to restore cooling performance and airflow.", defaultIssueType: "Cleaning" },
  { id: "repair", title: "Repair", summary: "Report faults, weak cooling, leaks, or other issues for diagnosis.", defaultIssueType: "Repair" },
  { id: "consultation", title: "Consultation", summary: "Request a site visit or service recommendation.", defaultIssueType: "Consultation" },
];

const normalizeOffering = (value = {}) => {
  const basePrice = Number(value.basePrice);
  const hasConfiguredPrice = Number.isFinite(basePrice) && basePrice >= 0;
  return {
    id: String(value.id || "").trim().toLowerCase(),
    title: String(value.title || "").trim(),
    summary: String(value.summary || "").trim(),
    defaultIssueType: String(value.defaultIssueType || value.title || "Service").trim(),
    pricing: {
      currency: String(value.currency || "PHP").trim().toUpperCase(),
      basePrice: hasConfiguredPrice ? basePrice : null,
      label: hasConfiguredPrice
        ? `PHP ${basePrice.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : String(value.pricingLabel || "Branch quote after assessment"),
    },
  };
};

const getServiceCatalog = (rawConfig = "") => {
  try {
    const parsed = rawConfig ? JSON.parse(rawConfig) : null;
    if (Array.isArray(parsed) && parsed.length) {
      const configured = parsed.map(normalizeOffering).filter((item) => item.id && item.title);
      if (configured.length) return configured;
    }
  } catch (_error) {
    // A malformed deployment setting must not make service booking unavailable.
  }
  return FALLBACK_SERVICE_CATALOG.map(normalizeOffering);
};

const findServiceOffering = (catalog = [], lookup = "") => {
  const target = String(lookup || "").trim().toLowerCase();
  return catalog.find((item) => item.id === target || item.title.toLowerCase() === target || item.defaultIssueType.toLowerCase() === target) || null;
};

module.exports = { getServiceCatalog, findServiceOffering };
