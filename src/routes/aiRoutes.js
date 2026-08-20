const express = require("express");

const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const { getUnitHealthInsight, generateAmpReport } = require("../controllers/aiController");

const router = express.Router();

router.post("/unit-health", requireAuthNoBranch, getUnitHealthInsight);
router.post(
  "/amp-report",
  requireAuthNoBranch,
  allowRoles("customer", "technician", "manager", "owner", "admin", "superadmin"),
  generateAmpReport,
);

module.exports = router;
