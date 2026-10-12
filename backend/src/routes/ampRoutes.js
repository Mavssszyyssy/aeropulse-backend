const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
  listMyUnits,
  calculateNextServiceDate,
  updateRoomSize,
  completeService,
  getManagerPipeline,
  getReportUnits,
  getOwnerForecast,
} = require("../controllers/ampController");

const router = express.Router();
const {
  getUnitDecisionSupport, generateRequestPreAssessment, generateTaskPreAssessment, getTaskDecisionSupport,
  generateFuturePrediction, reviewDecisionSupport,
} = require("../controllers/maintenanceDecisionController");

router.use(requireAuth);

router.post("/requests/:requestId/pre-assessment", allowRoles("admin", "superadmin"), generateRequestPreAssessment);
router.get("/units/:unitId/decision-support", allowRoles("admin", "superadmin"), getUnitDecisionSupport);
router.get("/tasks/:taskId/decision-support", allowRoles("technician", "admin", "superadmin"), getTaskDecisionSupport);
router.post("/tasks/:taskId/pre-assessment", allowRoles("technician", "admin", "superadmin"), generateTaskPreAssessment);
router.post("/tasks/:taskId/future-prediction", allowRoles("technician", "admin", "superadmin"), generateFuturePrediction);
router.patch("/tasks/:taskId/:phase/review", allowRoles("technician"), reviewDecisionSupport);

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
  "/report-units",
  allowRoles("manager", "owner", "admin", "superadmin"),
  getReportUnits,
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

router.patch(
  "/units/:unitId/room-size",
  allowRoles("technician", "admin", "superadmin"),
  updateRoomSize,
);

router.post(
  "/units/:unitId/complete-service",
  allowRoles("technician", "admin", "superadmin"),
  completeService,
);

module.exports = router;
