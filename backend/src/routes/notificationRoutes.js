const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
	listMyNotifications,
	markNotificationRead,
	markAllNotificationsRead,
	archiveNotification,
	restoreNotification,
	registerPushToken,
	unregisterPushToken,
} = require("../controllers/notificationController");

const router = express.Router();

router.use(requireAuth);
router.get("/me", listMyNotifications);
router.patch("/me/read-all", markAllNotificationsRead);
router.post("/read-all", markAllNotificationsRead);
router.post("/push-token", registerPushToken);
router.delete("/push-token", unregisterPushToken);
router.patch("/:id/read", markNotificationRead);
router.patch("/:id/archive", archiveNotification);
router.patch("/:id/restore", restoreNotification);

module.exports = router;
