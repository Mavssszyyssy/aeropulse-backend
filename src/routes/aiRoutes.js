const express = require("express");

const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const { getMaintenanceRecommendation, generateAmpReport } = require("../controllers/aiController");

const router = express.Router();

router.post("/maintenance-recommendation", requireAuthNoBranch, getMaintenanceRecommendation);
router.post(
  "/amp-report",
  requireAuthNoBranch,
  allowRoles("customer", "technician", "manager", "owner", "admin", "superadmin"),
  generateAmpReport,
);

module.exports = router;
