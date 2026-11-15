const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { limitTextFields } = require("../middleware/limitTextFields");
const {
  listBranchCoverage,
  resolveBranchCoverage,
  updateBranchCoverage,
  createBranchCoverage,
} = require("../controllers/branchCoverageController");

const router = express.Router();
const coverageText = limitTextFields({ coverageAreas: [2000, "Service areas", true] });

router.get("/", listBranchCoverage);
router.get("/resolve", resolveBranchCoverage);
router.post("/", requireAuth, allowRoles("superadmin"), coverageText, createBranchCoverage);
router.put("/:branchName", requireAuth, allowRoles("superadmin"), coverageText, updateBranchCoverage);

module.exports = router;
