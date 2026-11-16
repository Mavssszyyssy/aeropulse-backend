const Notification = require("../models/Notification");
const User = require("../models/User");
const { isObjectIdOrHexString } = require("mongoose");
const { reconcileRequiredActionsForUser } = require("../services/requiredActionReminderService");

const STAFF_ROLES = ["admin", "superadmin", "manager", "owner"];

const notificationDuplicateScope = (notification) => {
  if (notification.dedupeKey) return { dedupeKey: notification.dedupeKey };
  return {
    dedupeKey: { $in: [null, ""] },
    type: (notification.type || "system") === "system" ? { $in: [null, "", "system"] } : notification.type,
    targetType: notification.targetType || { $in: [null, ""] },
    targetId: notification.targetId || { $in: [null, ""] },
    title: notification.title,
    message: notification.message,
  };
};

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
        "Your technician workspace is ready. New work order notifications will appear here.",
      status:
        "Open My Work Orders to review Admin-activated assignments, check in with GPS, and scan assigned unit QR codes.",
    };
  }

  if (isStaff) {
    return {
      welcome:
        "Your operations inbox is ready. Order, inventory, and branch notifications will appear here.",
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
  return notifications.map((item) => {
    const json = item.toJSON ? item.toJSON() : { ...item };
    // Queries in this endpoint use `lean()`, so Mongoose does not add its
    // virtual `id` field. Every client needs the same public identifier to
    // open and mark an alert as read, regardless of the user's role.
    if (!json.id && json._id) json.id = String(json._id);
    delete json._id;
    delete json.__v;

    if (!STAFF_ROLES.includes(normalizedRole) && normalizedRole !== "technician") {
      return json;
    }

    const messages = roleMessages(normalizedRole);
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

const applyRoleRelevance = (notifications = [], role = "customer") => {
  if (String(role || "").toLowerCase() !== "technician") return notifications;
  return notifications.filter((item) => {
    const title = String(item?.title || "").trim().toLowerCase();
    const dedupeKey = String(item?.dedupeKey || "").trim().toLowerCase();
    // Older releases broadcast unassigned orders to every branch technician,
    // but those orders are intentionally absent from My Work until Admin
    // chooses a technician. Keep those obsolete, non-actionable alerts out of
    // both the technician inbox and unread badge.
    return title !== "work order awaiting assignment"
      && !dedupeKey.startsWith("unassigned-order-task:");
  });
};

const listMyNotifications = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const userId = req.authUser._id;
  const user = await User.findById(userId)
    .select("notifications lastLogin role activeBranch assignedBranch")
    .lean();
  const userNotifications = user?.notifications?.toObject?.() || user?.notifications || {};
  if (userNotifications.inApp === false) {
    return res.json({ notifications: [], unreadCount: 0, hasMore: false });
  }

  // Fetch beyond the drawer's display size before collapsing duplicates and
  // applying preferences. Otherwise, suppressed alerts in the newest 30 can
  // hide older unread alerts that the user is still meant to see.
  const archivedView = String(req.query?.view || "active").toLowerCase() === "archived";
  const requestedPage = Number(req.query?.page);
  const archiveOffset = Number.isSafeInteger(requestedPage) && requestedPage > 1
    ? (requestedPage - 1) * 30 : 0;
  // The full Superadmin operations inbox paginates its filtered results in the
  // client. The compact notification drawers retain their 30-item response.
  const operationsView = req.query?.scope === "operations"
    && String(user?.role || "").toLowerCase() === "superadmin"
    && !archivedView;
  const mobileView = req.query?.scope === "mobile"
    && ["customer", "technician"].includes(String(user?.role || "").toLowerCase())
    && !archivedView;
  const mobileLimit = mobileView ? Math.min(200, Math.max(30, Math.floor(Number(req.query?.limit) || 30))) : 30;
  if (!archivedView) {
    try {
      await reconcileRequiredActionsForUser(user);
    } catch (error) {
      // A reminder reconciliation must never make the notification inbox unavailable.
      console.warn("Required-action reminder reconciliation failed:", error.message);
    }
  }
  const archiveScope = archivedView
    ? { archivedAt: { $ne: null } }
    : { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] };
  const notificationFields = "type branch category severity title message route targetId targetType dedupeKey status unread archivedAt createdAt updatedAt";
  const notificationsQuery = () => Notification.find({ user: userId, ...archiveScope })
    .select(notificationFields)
    .sort(archivedView ? { createdAt: -1, _id: -1 } : { createdAt: -1 });
  const inboxQuery = notificationsQuery();
  let archiveReadLimit = Math.min(500, Math.max(100, archiveOffset + 31));
  if (archivedView) inboxQuery.limit(archiveReadLimit);
  else if (!operationsView && !mobileView) inboxQuery.limit(100);
  let notifications = await inboxQuery.lean();

  if (!archivedView && !notifications.length && !await Notification.exists({ user: userId })) {
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
    const welcomeQuery = notificationsQuery();
    if (!operationsView && !mobileView) welcomeQuery.limit(100);
    notifications = await welcomeQuery.lean();
  }

  const activeNotifications = archivedView
    ? await Notification.find({
      user: userId,
      $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }],
    }).select(notificationFields).sort({ createdAt: -1 }).limit(100).lean()
    : notifications;
  const unreadCount = applyNotificationPreferences(
    applyRoleRelevance(activeNotifications, user?.role),
    userNotifications,
  )
    .filter((item) => item.unread || item.status === "unread").length;
  const visible = (items) => applyNotificationPreferences(applyRoleRelevance(items, user?.role), userNotifications);
  let visibleNotifications = visible(notifications);
  // Read more only when deduplication or notification preferences leave the requested archive page short.
  while (archivedView && notifications.length === archiveReadLimit && visibleNotifications.length <= archiveOffset + 30) {
    archiveReadLimit *= 2;
    notifications = await notificationsQuery().limit(archiveReadLimit).lean();
    visibleNotifications = visible(notifications);
  }
  notifications = visibleNotifications;
  const hasMore = archivedView ? notifications.length > archiveOffset + 30
    : mobileView && notifications.length > mobileLimit;
  if (archivedView) notifications = notifications.slice(archiveOffset, archiveOffset + 30);
  else if (mobileView) notifications = notifications.slice(0, mobileLimit);
  else if (!operationsView) notifications = notifications.slice(0, 30);

  return res.json({
    notifications: sanitizeLegacyNotifications(notifications, user?.role),
    unreadCount,
    hasMore,
  });
};

const archiveUpdate = () => ({ $set: { archivedAt: new Date(), unread: false, status: "read" } });

const archiveAllNotifications = async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.authUser._id, archivedAt: null },
    archiveUpdate(),
  );
  return res.json({ modifiedCount: Number(result.modifiedCount || 0) });
};

const archiveSelectedNotifications = async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30
    || ids.some((id) => typeof id !== "string" || !isObjectIdOrHexString(id))) {
    return res.status(400).json({ message: "Select between 1 and 30 valid alerts." });
  }
  const result = await Notification.updateMany(
    { user: req.authUser._id, archivedAt: null, _id: { $in: [...new Set(ids)] } },
    archiveUpdate(),
  );
  return res.json({ modifiedCount: Number(result.modifiedCount || 0) });
};

const archiveNotification = async (req, res) => {
  const archive = archiveUpdate();
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.authUser._id },
    archive,
    { new: true },
  );
  if (!notification) return res.status(404).json({ message: "Notification not found" });
  if (req.authUser.role === "technician") {
    // The technician inbox renders these duplicate records as one alert.
    await Notification.updateMany(
      { user: req.authUser._id, archivedAt: null, ...notificationDuplicateScope(notification) },
      archive,
    );
  }
  return res.json({ notification: notification.toJSON() });
};

const restoreNotification = async (req, res) => {
  const user = req.authUser._id;
  const notification = await Notification.findOne({ _id: req.params.id, user });
  if (!notification) return res.status(404).json({ message: "Notification not found" });
  await Notification.updateMany(
    { user, archivedAt: { $ne: null }, $or: [{ _id: notification._id }, notificationDuplicateScope(notification)] },
    { $set: { archivedAt: null } },
  );
  return res.json({ notification: { ...notification.toJSON(), archivedAt: null } });
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
  if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]\s]{1,200}\]$/.test(expoPushToken)) {
    return res.status(400).json({ message: "A valid Expo push token is required." });
  }

  // A physical device may be used by different accounts. Move its token to
  // the authenticated account so a later login cannot receive another user's alerts.
  await User.updateMany(
    { _id: { $ne: req.authUser._id }, expoPushTokens: expoPushToken },
    { $pull: { expoPushTokens: expoPushToken } },
  );
  await User.updateOne(
    { _id: req.authUser._id },
    { $addToSet: { expoPushTokens: expoPushToken } },
  );
  return res.json({ message: "Push notifications enabled for this device." });
};

const unregisterPushToken = async (req, res) => {
  const expoPushToken = String(req.body?.expoPushToken || "").trim();
  if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]\s]{1,200}\]$/.test(expoPushToken)) {
    return res.status(400).json({ message: "A valid Expo push token is required." });
  }
  await User.updateOne(
    { _id: req.authUser._id },
    { $pull: { expoPushTokens: expoPushToken } },
  );
  return res.json({ message: "Push notifications disabled for this device." });
};

module.exports = {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  archiveNotification,
  archiveAllNotifications,
  archiveSelectedNotifications,
  restoreNotification,
  registerPushToken,
  unregisterPushToken,
  applyRoleRelevance,
};
