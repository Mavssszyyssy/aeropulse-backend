const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  listBranchCoverage,
  resolveBranchCoverage,
  updateBranchCoverage,
  createBranchCoverage,
} = require("../controllers/branchCoverageController");

const router = express.Router();

router.get("/", listBranchCoverage);
router.get("/resolve", resolveBranchCoverage);
router.post("/", requireAuth, allowRoles("superadmin"), createBranchCoverage);
router.put("/:branchName", requireAuth, allowRoles("superadmin"), updateBranchCoverage);

module.exports = router;
