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
        "Open My Work Orders to review Admin-activated assignments, check in with GPS, and scan assigned unit QR codes.",
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
      "Visit My Orders to monitor payment, delivery, installation, and completion states.",
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

const applyNotificationPreferences = (notifications = [], preferences = {}) =>
  collapseDuplicateNotifications(notifications).filter((item) => {
    if (item.type === "account" && preferences.accountUpdates === false) return false;
    if (["order", "payment", "delivery"].includes(item.type) && preferences.orderUpdates === false) return false;
    if (["technician", "service", "warranty"].includes(item.type) && preferences.serviceUpdates === false) return false;
    if (["system", "inventory", "report"].includes(item.type) && preferences.systemAlerts === false) return false;
    return true;
  });

const listMyNotifications = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const userId = req.authUser._id;
  const user = await User.findById(userId).select("notifications lastLogin role");
  const userNotifications = user?.notifications?.toObject?.() || user?.notifications || {};
  if (userNotifications.inApp === false) {
    return res.json({ notifications: [], unreadCount: 0 });
  }

  // Fetch beyond the drawer's display size before collapsing duplicates and
  // applying preferences. Otherwise, suppressed alerts in the newest 30 can
  // hide older unread alerts that the user is still meant to see.
  const archivedView = String(req.query?.view || "active").toLowerCase() === "archived";
  const archiveScope = archivedView
    ? { archivedAt: { $ne: null } }
    : { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] };
  let notifications = await Notification.find({ user: userId, ...archiveScope }).sort({ createdAt: -1 }).limit(100);

  const hasAnyStoredNotification = notifications.length > 0
    || Boolean(await Notification.exists({ user: userId }));
  if (!hasAnyStoredNotification && !archivedView) {
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
    notifications = await Notification.find({ user: userId, ...archiveScope }).sort({ createdAt: -1 }).limit(100);
  }

  const activeNotifications = archivedView
    ? await Notification.find({
      user: userId,
      $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }],
    }).sort({ createdAt: -1 }).limit(100)
    : notifications;
  const unreadCount = applyNotificationPreferences(activeNotifications, userNotifications)
    .filter((item) => item.unread || item.status === "unread").length;
  notifications = applyNotificationPreferences(notifications, userNotifications).slice(0, 30);

  return res.json({
    notifications: sanitizeLegacyNotifications(notifications, user?.role),
    unreadCount,
  });
};

const archiveNotification = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.authUser._id },
    { $set: { archivedAt: new Date(), unread: false, status: "read" } },
    { new: true },
  );
  if (!notification) return res.status(404).json({ message: "Notification not found" });
  return res.json({ notification: notification.toJSON() });
};

const restoreNotification = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.authUser._id },
    { $set: { archivedAt: null } },
    { new: true },
  );
  if (!notification) return res.status(404).json({ message: "Notification not found" });
  return res.json({ notification: notification.toJSON() });
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
      $and: [
        { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] },
        { $or: [{ unread: true }, { status: "unread" }] },
      ],
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
  archiveNotification,
  restoreNotification,
  registerPushToken,
};
