const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
	listMyNotifications,
	markNotificationRead,
	markAllNotificationsRead,
	archiveNotification,
	archiveAllNotifications,
	archiveSelectedNotifications,
	restoreNotification,
	registerPushToken,
	unregisterPushToken,
} = require("../controllers/notificationController");

const router = express.Router();

router.use(requireAuth);
router.get("/me", listMyNotifications);
router.patch("/me/read-all", markAllNotificationsRead);
router.patch("/me/archive-all", archiveAllNotifications);
router.patch("/me/archive-selected", archiveSelectedNotifications);
router.post("/read-all", markAllNotificationsRead);
router.post("/push-token", registerPushToken);
router.delete("/push-token", unregisterPushToken);
router.patch("/:id/read", markNotificationRead);
router.patch("/:id/archive", archiveNotification);
router.patch("/:id/restore", restoreNotification);

module.exports = router;
