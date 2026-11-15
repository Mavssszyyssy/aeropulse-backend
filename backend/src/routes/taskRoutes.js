const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
	listTasks,
	createTask,
	updateTask,
	getTaskById,
	acceptTask,
	checkInTask,
  confirmInstallationArrival,
  confirmCodCollection,
	getRegistrationContextBySerial,
	getTechnicianUnitHistoryBySerial,
	registerAmpUnit,
	updateTaskStatus,
} = require("../controllers/taskController");

const { limitTextFields } = require("../middleware/limitTextFields");
const { workOrderText, serviceReportText } = require("../middleware/workOrderText");

const router = express.Router();

const { collectServicePayment } = require("../controllers/servicePaymentController");
const { getVisitAttempt, submitVisitAttempt, scheduleNextVisit } = require('../controllers/visitAttemptController');

router.use(requireAuth);
router.get("/", allowRoles("customer", "technician", "admin", "superadmin"), listTasks);
router.post("/", allowRoles("admin", "superadmin"), workOrderText, createTask);
router.get("/registration-context/:serialNumber", allowRoles("technician", "admin", "superadmin"), getRegistrationContextBySerial);
router.get("/unit-history/:serialNumber", allowRoles("technician", "admin", "superadmin"), getTechnicianUnitHistoryBySerial);
router.get("/:taskId", allowRoles("technician", "admin", "superadmin"), getTaskById);
router.patch("/:taskId/accept", allowRoles("technician"), acceptTask);
router.patch("/:taskId/check-in", allowRoles("technician"), checkInTask);
router.patch("/:taskId/arrival-validation", allowRoles("technician"), confirmInstallationArrival);
router.get('/:taskId/visit-attempt', allowRoles('technician', 'admin', 'superadmin'), getVisitAttempt);
router.patch('/:taskId/visit-attempt', allowRoles('technician'), submitVisitAttempt);
router.patch('/:taskId/next-visit', allowRoles('admin', 'superadmin'), scheduleNextVisit);
router.patch("/:taskId/cod-collection", allowRoles("technician"), confirmCodCollection);
router.patch("/:taskId/service-payment", allowRoles("technician"), collectServicePayment);
router.patch("/:taskId/amp-registration", allowRoles("technician"), limitTextFields({ notes: [1000, "Notes"], serialNumber: [1024, "Serial number"] }), registerAmpUnit);
router.patch("/:taskId", allowRoles("technician", "admin", "superadmin"), workOrderText, serviceReportText, updateTask);
router.patch("/:taskId/status", allowRoles("technician", "admin", "superadmin"), serviceReportText, updateTaskStatus);

module.exports = router;
