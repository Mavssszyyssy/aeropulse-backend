const BranchCoverage = require("../models/BranchCoverage");

const DEFAULT_BRANCH_COVERAGE = [
  { name: "Bulacan", coverageAreas: ["bulacan", "plaridel", "malolos", "manila", "quezon city"], nearbyBranches: ["Bataan", "Cavite", "Laguna", "Pangasinan", "Ilocos"] },
  { name: "Cavite", coverageAreas: ["bacoor", "dasmarinas", "dasmariñas"], nearbyBranches: ["Laguna", "Bulacan", "Bataan", "Pangasinan", "Ilocos"] },
  { name: "Laguna", coverageAreas: ["laguna", "cabuyao", "cavite", "batangas"], nearbyBranches: ["Cavite", "Bulacan", "Bataan", "Pangasinan", "Ilocos"] },
  { name: "Bataan", coverageAreas: ["bataan", "balanga"], nearbyBranches: ["Bulacan", "Pangasinan", "Cavite", "Laguna", "Ilocos"] },
  { name: "Pangasinan", coverageAreas: ["pangasinan", "dagupan", "tarlac"], nearbyBranches: ["Ilocos", "Bataan", "Bulacan", "Laguna", "Cavite"] },
  { name: "Ilocos", coverageAreas: ["ilocos", "la union", "san fernando"], nearbyBranches: ["Pangasinan", "Bataan", "Bulacan", "Laguna", "Cavite"] },
];

const normalize = (value = "") => String(value).trim().toLowerCase();
const uniqueValues = (values = []) => Array.from(new Set(
  values.map((value) => String(value || "").trim()).filter(Boolean),
));

let coverageCache = null;
let coverageCacheExpiresAt = 0;

const clearBranchCoverageCache = () => {
  coverageCache = null;
  coverageCacheExpiresAt = 0;
};

const ensureDefaultBranchCoverage = async () => {
  // Upserts make concurrent first requests safe on serverless cold starts and
  // preserve every later Super Admin change through $setOnInsert.
  await BranchCoverage.bulkWrite(
    DEFAULT_BRANCH_COVERAGE.map((branch) => ({
      updateOne: {
        filter: { name: branch.name },
        update: { $setOnInsert: { ...branch, active: true } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
};

const getBranchCoverage = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh && coverageCache && Date.now() < coverageCacheExpiresAt) {
    return coverageCache;
  }

  await ensureDefaultBranchCoverage();
  const branches = await BranchCoverage.find({ active: true })
    .select("name active coverageAreas nearbyBranches")
    .sort({ name: 1 })
    .lean();
  coverageCache = branches.map((branch) => ({
    ...branch,
    coverageAreas: uniqueValues(branch.coverageAreas).map(normalize).filter(Boolean),
    nearbyBranches: uniqueValues(branch.nearbyBranches),
  }));
  coverageCacheExpiresAt = Date.now() + 60 * 1000;
  return coverageCache;
};

const getAddressLookupKeys = (address = {}) => uniqueValues([
  address.city,
  address.province,
  address.region,
  address.barangay,
  address.street,
]).map(normalize).filter(Boolean);

const resolveConfiguredBranch = async (address = {}) => {
  const keys = getAddressLookupKeys(address);
  if (!keys.length) return null;
  const branches = await getBranchCoverage();

  for (const key of keys) {
    const match = branches.find((branch) => branch.coverageAreas.includes(key));
    if (match) return match;
  }
  for (const key of keys) {
    const match = branches.find((branch) => branch.coverageAreas.some((area) => key.includes(area)));
    if (match) return match;
  }
  return null;
};

const getConfiguredBranchSearchOrder = async (preferredBranch = "") => {
  const branches = await getBranchCoverage();
  const preferred = branches.find((branch) => branch.name === preferredBranch);
  if (!preferred) return [];
  const allowedNames = new Set(branches.map((branch) => branch.name));
  return uniqueValues([preferred.name, ...preferred.nearbyBranches])
    .filter((name) => allowedNames.has(name));
};

module.exports = {
  DEFAULT_BRANCH_COVERAGE,
  clearBranchCoverageCache,
  getAddressLookupKeys,
  getBranchCoverage,
  getConfiguredBranchSearchOrder,
  resolveConfiguredBranch,
  uniqueValues,
};
