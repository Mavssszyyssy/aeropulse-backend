const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
	listTasks,
	createTask,
	updateTask,
	getTaskById,
	acceptTask,
	getRegistrationContextBySerial,
	registerAmpUnit,
	updateTaskStatus,
} = require("../controllers/taskController");

const router = express.Router();

router.use(requireAuth);
router.get("/", listTasks);
router.post("/", createTask);
router.get("/registration-context/:serialNumber", getRegistrationContextBySerial);
router.get("/:taskId", getTaskById);
router.patch("/:taskId/accept", acceptTask);
router.patch("/:taskId/amp-registration", registerAmpUnit);
router.patch("/:taskId", updateTask);
router.patch("/:taskId/status", updateTaskStatus);

module.exports = router;
