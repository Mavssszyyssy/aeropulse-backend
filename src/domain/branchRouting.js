const BRANCHES = [
  "Bulacan",
  "Cavite",
  "Laguna",
  "Bataan",
  "Pangasinan",
  "Ilocos",
];

// Used only for technician workload balancing. Customer address assignment
// itself comes from the database-backed coverage service below.
const BRANCH_PRIORITY = {
  Bulacan: ["Bulacan", "Bataan", "Cavite", "Laguna", "Pangasinan", "Ilocos"],
  Cavite: ["Cavite", "Laguna", "Bulacan", "Bataan", "Pangasinan", "Ilocos"],
  Laguna: ["Laguna", "Cavite", "Bulacan", "Bataan", "Pangasinan", "Ilocos"],
  Bataan: ["Bataan", "Bulacan", "Pangasinan", "Cavite", "Laguna", "Ilocos"],
  Pangasinan: ["Pangasinan", "Ilocos", "Bataan", "Bulacan", "Laguna", "Cavite"],
  Ilocos: ["Ilocos", "Pangasinan", "Bataan", "Bulacan", "Laguna", "Cavite"],
};

const {
  getAddressLookupKeys,
  getConfiguredBranchSearchOrder,
  resolveConfiguredBranch,
} = require("../services/branchCoverageService");

// Address routing is intentionally asynchronous because coverage is managed
// in MongoDB by Super Admins. An unmatched address is never assigned to a
// default branch; callers must ask the customer to choose a covered address.
const resolvePreferredBranch = async (address = {}) => {
  const branch = await resolveConfiguredBranch(address);
  return branch?.name || "";
};

const getBranchSearchOrder = async (preferredBranch) =>
  getConfiguredBranchSearchOrder(preferredBranch);

module.exports = {
  BRANCHES,
  BRANCH_PRIORITY,
  getAddressLookupKeys,
  resolvePreferredBranch,
  getBranchSearchOrder,
};
