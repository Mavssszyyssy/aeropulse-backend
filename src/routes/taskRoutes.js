const express = require("express");
const { requireAuth, allowRoles } = require("../middleware/auth");
const {
	listTasks,
	createTask,
	updateTask,
	getTaskById,
	acceptTask,
	checkInTask,
	getRegistrationContextBySerial,
	getTechnicianUnitHistoryBySerial,
	registerAmpUnit,
	updateTaskStatus,
} = require("../controllers/taskController");

const router = express.Router();

router.use(requireAuth);
router.get("/", allowRoles("technician", "admin", "superadmin"), listTasks);
router.post("/", allowRoles("admin", "superadmin"), createTask);
router.get("/registration-context/:serialNumber", allowRoles("technician", "admin", "superadmin"), getRegistrationContextBySerial);
router.get("/unit-history/:serialNumber", allowRoles("technician", "admin", "superadmin"), getTechnicianUnitHistoryBySerial);
router.get("/:taskId", allowRoles("technician", "admin", "superadmin"), getTaskById);
router.patch("/:taskId/accept", allowRoles("technician"), acceptTask);
router.patch("/:taskId/check-in", allowRoles("technician"), checkInTask);
router.patch("/:taskId/amp-registration", allowRoles("technician"), registerAmpUnit);
router.patch("/:taskId", allowRoles("technician", "admin", "superadmin"), updateTask);
router.patch("/:taskId/status", allowRoles("technician", "admin", "superadmin"), updateTaskStatus);

module.exports = router;
