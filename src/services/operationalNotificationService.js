const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const User = require("../models/User");

const canReceive = (user, type = "system") => {
  const preferences = user?.notifications?.toObject?.() || user?.notifications || {};
  if (preferences.inApp === false && preferences.push === false) return false;
  if (["order", "payment", "delivery"].includes(type) && preferences.orderUpdates === false) return false;
  if (["account", "security"].includes(type) && preferences.accountUpdates === false) return false;
  if (["system", "inventory", "technician", "service", "warranty", "report"].includes(type) && preferences.systemAlerts === false) return false;
  return true;
};

const createDedupedNotification = async (payload = {}, { dedupeMinutes = 60 } = {}) => {
  if (!payload.user || !mongoose.Types.ObjectId.isValid(String(payload.user))) return null;
  const dedupeKey = String(payload.dedupeKey || "").trim();
  if (dedupeKey) {
    const since = new Date(Date.now() - Math.max(1, Number(dedupeMinutes || 60)) * 60 * 1000);
    const existing = await Notification.findOne({
      user: payload.user,
      dedupeKey,
      createdAt: { $gte: since },
    }).sort({ createdAt: -1 });
    if (existing) return existing;
  }
  return Notification.create({
    unread: true,
    status: "unread",
    severity: "info",
    ...payload,
    dedupeKey,
  });
};

const notifyOperationalStaff = async ({
  branch = "",
  title,
  message,
  type = "system",
  category = "",
  severity = "info",
  targetId = "",
  targetType = "",
  dedupeKey = "",
  roles = ["admin", "superadmin"],
} = {}) => {
  if (!title || !message) return [];
  const normalizedBranch = String(branch || "").trim();
  const users = await User.find({
    role: { $in: roles },
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
  }).select("_id role activeBranch assignedBranch notifications");
  const recipients = users.filter((user) => {
    if (!canReceive(user, type)) return false;
    if (String(user.role || "") === "superadmin" || !normalizedBranch) return true;
    const assigned = String(user.activeBranch || user.assignedBranch || "").trim();
    return !assigned || assigned === normalizedBranch;
  });
  return Promise.all(
    recipients.map((user) =>
      createDedupedNotification({
        user: user._id,
        type,
        category,
        severity,
        title,
        message,
        targetId: String(targetId || ""),
        targetType,
        dedupeKey: dedupeKey ? `${dedupeKey}:${user._id}` : "",
      }),
    ),
  );
};

module.exports = { createDedupedNotification, notifyOperationalStaff };
