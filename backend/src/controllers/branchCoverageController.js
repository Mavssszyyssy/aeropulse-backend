const BranchCoverage = require("../models/BranchCoverage");
const { BRANCHES, setConfiguredBranches } = require("../domain/branchRouting");
const { validateBranchName, validateServiceAreas } = require("../domain/branchInputValidation");
const {
  DEFAULT_BRANCH_COVERAGE,
  clearBranchCoverageCache,
  getBranchCoverage,
  getConfiguredBranchSearchOrder,
  resolveConfiguredBranch,
  uniqueValues,
} = require("../services/branchCoverageService");

const configuredLocations = DEFAULT_BRANCH_COVERAGE.flatMap((branch) => [branch.name, ...branch.coverageAreas]);
const normalizeCoverageAreas = (value) => validateServiceAreas(value, configuredLocations);

const listBranchCoverage = async (_req, res) => {
  try {
    const branches = await getBranchCoverage({ forceRefresh: true });
    return res.json({ branches });
  } catch (error) {
    console.error("Unable to load branch coverage:", error);
    return res.status(500).json({ message: "Unable to load branch coverage." });
  }
};

const createBranchCoverage = async (req, res) => {
  try {
    const nameValidation = validateBranchName(req.body?.name);
    if (nameValidation.error) return res.status(400).json({ message: nameValidation.error });
    const name = nameValidation.name.toLocaleLowerCase("en").replace(/(^|[\s'-])\p{L}/gu, (part) => part.toLocaleUpperCase("en"));
    const validation = normalizeCoverageAreas(req.body?.coverageAreas);
    if (validation.error || !validation.coverageAreas.length) {
      return res.status(400).json({ message: validation.error || "Enter at least one service area." });
    }
    if (await BranchCoverage.exists({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })) {
      return res.status(409).json({ message: "A branch with this name already exists." });
    }
    const existing = await getBranchCoverage();
    const occupied = existing.find((branch) => branch.coverageAreas.some((area) => validation.coverageAreas.includes(area)));
    if (occupied) return res.status(409).json({ message: `A service area is already assigned to ${occupied.name}.` });
    const nearbyBranches = uniqueValues(req.body?.nearbyBranches || []).filter((item) => BRANCHES.includes(item) && item !== name);
    const branch = await BranchCoverage.create({ name, active: true, coverageAreas: validation.coverageAreas, nearbyBranches });
    clearBranchCoverageCache();
    setConfiguredBranches([...BRANCHES, name]);
    return res.status(201).json({ branch });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "A branch with this name already exists." });
    console.error("Unable to create branch:", error);
    return res.status(500).json({ message: "Unable to create branch." });
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
    if (!BRANCHES.includes(name)) return res.status(400).json({ message: "Select an existing branch." });
    const validation = normalizeCoverageAreas(req.body?.coverageAreas);
    if (validation.error) return res.status(400).json({ message: validation.error });
    const coverageAreas = validation.coverageAreas;
    const nearbyBranches = uniqueValues(req.body?.nearbyBranches || []);
    const active = req.body?.active !== false;
    const branch = await BranchCoverage.findOneAndUpdate(
      { name },
      { $set: { active, coverageAreas, nearbyBranches } },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    ).lean();
    clearBranchCoverageCache();
    return res.json({ branch });
  } catch (error) {
    console.error("Unable to update branch coverage:", error);
    return res.status(500).json({ message: "Unable to save branch coverage." });
  }
};

module.exports = { listBranchCoverage, resolveBranchCoverage, updateBranchCoverage, createBranchCoverage, normalizeCoverageAreas };
