const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
	listMyNotifications,
	markNotificationRead,
	markAllNotificationsRead,
	registerPushToken,
} = require("../controllers/notificationController");

const router = express.Router();

router.use(requireAuth);
router.get("/me", listMyNotifications);
router.patch("/me/read-all", markAllNotificationsRead);
router.post("/read-all", markAllNotificationsRead);
router.post("/push-token", registerPushToken);
router.patch("/:id/read", markNotificationRead);

module.exports = router;
