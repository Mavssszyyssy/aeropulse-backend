const express = require("express");
const { requireAuthNoBranch, allowRoles } = require("../middleware/auth");
const {
  listMyUnits,
  calculateNextServiceDate,
  completeService,
  getManagerPipeline,
  getOwnerForecast,
} = require("../controllers/ampController");

const router = express.Router();

router.use(requireAuthNoBranch);

router.get(
  "/customer/units",
  allowRoles("customer"),
  listMyUnits,
);

router.get(
  "/manager/pipeline",
  allowRoles("manager", "owner", "admin", "superadmin"),
  getManagerPipeline,
);

router.get(
  "/owner/forecast",
  allowRoles("owner", "superadmin"),
  getOwnerForecast,
);

router.get(
  "/units/:unitId/next-service",
  allowRoles("customer", "technician", "manager", "owner", "admin", "superadmin"),
  calculateNextServiceDate,
);

router.post(
  "/units/:unitId/complete-service",
  allowRoles("technician", "admin", "superadmin"),
  completeService,
);

module.exports = router;
