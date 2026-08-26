const Notification = require("../models/Notification");
const User = require("../models/User");

const STAFF_ROLES = ["admin", "superadmin", "manager", "owner"];

const collapseDuplicateNotifications = (notifications = []) => {
  const seen = new Set();
  return notifications.filter((item) => {
    const json = item.toJSON ? item.toJSON() : item;
    // Event producers provide a precise key. Legacy alerts are only collapsed
    // when their title, message, target and type are genuinely identical.
    const key = String(
      json.dedupeKey || `${json.type || "system"}:${json.targetType || ""}:${json.targetId || ""}:${json.title || ""}:${json.message || ""}`,
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const roleMessages = (role = "customer", isFirstLogin = false) => {
  const normalizedRole = String(role || "customer").toLowerCase();
  const isStaff = STAFF_ROLES.includes(normalizedRole);

  if (normalizedRole === "technician") {
    return {
      welcome:
        "Your technician workspace is ready. New work order alerts will appear here.",
      status:
        "Open My Work Orders to review assignments, accept tasks, and scan assigned unit QR codes.",
    };
  }

  if (isStaff) {
    return {
      welcome:
        "Your operations inbox is ready. Order, inventory, and branch alerts will appear here.",
      status:
        "Use Admin Orders and inventory screens to process new transactions from customer checkout.",
    };
  }

  return {
    welcome: isFirstLogin
      ? "Your account is ready. You can now shop, book services, and track orders."
      : "Great to see you again! Check out new products and manage your orders.",
    status:
      "Visit My Orders or Profile to monitor TO PAY, TO DELIVER, TO INSTALL, and COMPLETE states.",
  };
};

const sanitizeLegacyNotifications = (notifications, role = "customer") => {
  const normalizedRole = String(role || "customer").toLowerCase();
  if (!STAFF_ROLES.includes(normalizedRole) && normalizedRole !== "technician") {
    return notifications;
  }

  const messages = roleMessages(normalizedRole);
  return notifications.map((item) => {
    const json = item.toJSON();
    if (
      json.title === "Welcome to AeroPulse" &&
      String(json.message || "").includes("shop, book services, and track orders")
    ) {
      return { ...json, message: messages.welcome };
    }
    if (
      json.title === "Track your order status" ||
      String(json.message || "").includes("Visit My Orders or Profile")
    ) {
      return {
        ...json,
        title: "Track live activity",
        message: messages.status,
      };
    }
    return json;
  });
};

const listMyNotifications = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const userId = req.authUser._id;
  const user = await User.findById(userId).select("notifications lastLogin role");
  const userNotifications = user?.notifications?.toObject?.() || user?.notifications || {};
  if (userNotifications.inApp === false || userNotifications.push === false) {
    return res.json({ notifications: [] });
  }

  let notifications = await Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(30);

  if (!notifications.length) {
    // Check if this is the user's first login
    const isFirstLogin = !user.lastLogin;
    const role = String(user?.role || "customer").toLowerCase();
    const welcomeTitle = isFirstLogin ? "Welcome to AeroPulse" : "Welcome back to AeroPulse";
    const { welcome: welcomeMessage, status: statusMessage } = roleMessages(
      role,
      isFirstLogin,
    );

    await Notification.insertMany([
      {
        user: userId,
        type: "account",
        title: welcomeTitle,
        message: welcomeMessage,
      },
      {
        user: userId,
        type: "system",
        title: "Track live activity",
        message: statusMessage,
      },
    ]);
    notifications = await Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(30);
  }

  notifications = collapseDuplicateNotifications(notifications).filter((item) => {
    if (item.type === "account" && userNotifications.accountUpdates === false) return false;
    if (item.type === "order" && userNotifications.orderUpdates === false) return false;
    if (item.type === "system" && userNotifications.systemAlerts === false) return false;
    return true;
  });

  return res.json({
    notifications: sanitizeLegacyNotifications(notifications, user?.role),
  });
};

const markNotificationRead = async (req, res) => {
  const userId = req.authUser._id;
  const { id } = req.params;

  const notification = await Notification.findOne({ _id: id, user: userId });
  if (!notification) {
    return res.status(404).json({ message: "Notification not found" });
  }

  notification.unread = false;
  notification.status = "read";
  await notification.save();
  return res.json({ notification: notification.toJSON() });
};

const markAllNotificationsRead = async (req, res) => {
  const userId = req.authUser._id;
  const result = await Notification.updateMany(
    {
      user: userId,
      $or: [{ unread: true }, { status: "unread" }],
    },
    { $set: { unread: false, status: "read" } }
  );

  return res.json({
    message: "Notifications marked as read",
    modifiedCount: Number(result.modifiedCount || 0),
  });
};

const registerPushToken = async (req, res) => {
  const expoPushToken = String(req.body?.expoPushToken || "").trim();
  if (!/^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(expoPushToken)) {
    return res.status(400).json({ message: "A valid Expo push token is required." });
  }

  await User.updateOne(
    { _id: req.authUser._id },
    { $addToSet: { expoPushTokens: expoPushToken } },
  );
  return res.json({ message: "Push notifications enabled for this device." });
};

module.exports = {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  registerPushToken,
};
