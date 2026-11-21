const { validateHumanText } = require("./textFieldValidation");
const serviceAreaReference = require("./serviceAreaNames.json");
const locationKey = (value) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/\b(?:city|municipality|province|of)\b/g, " ")
  .replace(/\bsto\.?\b/g, "santo").replace(/\bsta\.?\b/g, "santa")
  .replace(/[^a-z0-9]+/g, " ").trim();
const verifiedAreas = new Set(serviceAreaReference.names.map(locationKey));
const locationAliases = { "metro manila": "ncr", "national capital region": "ncr", ilocos: "ilocos region", bicol: "bicol region", mimaropa: "mimaropa region", "cordillera administrative region": "car" };
const isKnownServiceArea = (value) => typeof value === "string" && verifiedAreas.has(locationAliases[locationKey(value)] || locationKey(value));
const LOCATION_MAX_LENGTH = 80;
const COVERAGE_MAX_LENGTH = 2000;
const repeatedCharacter = /(.)\1{4,}/iu;
const normalizeLocation = (value) => value.trim().replace(/\s+/gu, " ");

function validateBranchName(value) {
  const name = typeof value === "string" ? normalizeLocation(value) : "";
  // A branch name is also used as an inventory map key, so periods are excluded.
  if (name.length < 2 || value.length > LOCATION_MAX_LENGTH
    || !/^[\p{L}\p{M}0-9 '-]+$/u.test(name) || !/\p{L}/u.test(name)) {
    return { error: "Enter a valid branch name of 2 to 80 characters." };
  }
  if (repeatedCharacter.test(name)) return { error: "Branch name contains too many repeated characters." };
  const contentError = validateHumanText(name, { max: LOCATION_MAX_LENGTH, label: "Branch name", kind: "label" });
  if (contentError) return { error: contentError };
  return { name };
}

function validateServiceAreas(value, knownLocations = []) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (!entries.length || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return { error: "Separate every service area with a comma; remove empty entries." };
  }
  if (entries.join(",").length > COVERAGE_MAX_LENGTH) return { error: "Service areas must be 2000 characters or fewer." };
  const coverageAreas = entries.map((entry) => normalizeLocation(entry).toLowerCase());
  if (coverageAreas.some((entry) => entry.length > LOCATION_MAX_LENGTH
    || !/^[\p{L}\p{M}0-9 .’'()/-]+$/u.test(entry) || !/\p{L}/u.test(entry))) {
    return { error: "Each service area must be a valid location name of 80 characters or fewer." };
  }
  if (coverageAreas.some((entry) => repeatedCharacter.test(entry))) {
    return { error: "A service area contains too many repeated characters." };
  }
  for (const entry of coverageAreas) {
    const error = validateHumanText(entry, { max: LOCATION_MAX_LENGTH, label: "Service area", kind: "location" });
    if (error) return { error };
  }
  if (new Set(coverageAreas).size !== coverageAreas.length) return { error: "Remove duplicate service areas." };

  const known = [...new Set(knownLocations.map((value) => normalizeLocation(value).toLowerCase()))].filter(Boolean);
  const knownPatterns = known.map((name) => new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "u"));
  if (coverageAreas.some((entry) => !known.includes(entry) && knownPatterns.filter((pattern) => pattern.test(entry)).length >= 2)) {
    return { error: "A service area looks like multiple locations. Separate them with commas." };
  }
  if (coverageAreas.some((entry) => !isKnownServiceArea(entry))) {
    return { error: "Enter a recognized region, province, city, municipality, or barangay as each service area." };
  }
  return { coverageAreas };
}

module.exports = { LOCATION_MAX_LENGTH, COVERAGE_MAX_LENGTH, validateBranchName, validateServiceAreas, isKnownServiceArea };
