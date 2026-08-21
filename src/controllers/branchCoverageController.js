const BranchCoverage = require("../models/BranchCoverage");
const {
  clearBranchCoverageCache,
  getBranchCoverage,
  getConfiguredBranchSearchOrder,
  resolveConfiguredBranch,
  uniqueValues,
} = require("../services/branchCoverageService");

const normalizeCoverageAreas = (value) => uniqueValues(Array.isArray(value) ? value : String(value || "").split(","))
  .map((item) => item.toLowerCase());

const listBranchCoverage = async (_req, res) => {
  try {
    const branches = await getBranchCoverage({ forceRefresh: true });
    return res.json({ branches });
  } catch (error) {
    console.error("Unable to load branch coverage:", error);
    return res.status(500).json({ message: "Unable to load branch coverage." });
  }
};

const resolveBranchCoverage = async (req, res) => {
  try {
    const address = {
      city: req.query.city || "",
      province: req.query.province || "",
      region: req.query.region || "",
      barangay: req.query.barangay || "",
      street: req.query.street || "",
    };
    const branch = await resolveConfiguredBranch(address);
    if (!branch) {
      return res.status(422).json({
        message: "This delivery address is outside the currently configured service areas.",
        branch: null,
        serviceable: false,
      });
    }
    return res.json({
      branch: branch.name,
      serviceable: true,
      searchOrder: await getConfiguredBranchSearchOrder(branch.name),
    });
  } catch (error) {
    console.error("Unable to resolve branch coverage:", error);
    return res.status(500).json({ message: "Unable to resolve the service branch." });
  }
};

const updateBranchCoverage = async (req, res) => {
  try {
    const name = String(req.params.branchName || "").trim();
    if (!name) return res.status(400).json({ message: "Branch name is required." });
    const coverageAreas = normalizeCoverageAreas(req.body?.coverageAreas);
    if (!coverageAreas.length) return res.status(400).json({ message: "Add at least one service area for this branch." });
    const nearbyBranches = uniqueValues(req.body?.nearbyBranches || []);
    const active = req.body?.active !== false;
    const branch = await BranchCoverage.findOneAndUpdate(
      { name },
      { $set: { active, coverageAreas, nearbyBranches } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    clearBranchCoverageCache();
    return res.json({ branch });
  } catch (error) {
    console.error("Unable to update branch coverage:", error);
    return res.status(500).json({ message: "Unable to save branch coverage." });
  }
};

module.exports = { listBranchCoverage, resolveBranchCoverage, updateBranchCoverage };
