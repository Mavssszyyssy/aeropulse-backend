const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { limitTextFields } = require("../middleware/limitTextFields");
const { COVERAGE_MAX_LENGTH } = require("../domain/branchInputValidation");
const {
  listBranchCoverage,
  resolveBranchCoverage,
  updateBranchCoverage,
  createBranchCoverage,
} = require("../controllers/branchCoverageController");

const router = express.Router();
const coverageText = limitTextFields({ coverageAreas: [COVERAGE_MAX_LENGTH, "Service areas", true] });

router.get("/", listBranchCoverage);
router.get("/resolve", resolveBranchCoverage);
router.post("/", requireAuth, allowRoles("superadmin"), coverageText, createBranchCoverage);
router.put("/:branchName", requireAuth, allowRoles("superadmin"), coverageText, updateBranchCoverage);

module.exports = router;
