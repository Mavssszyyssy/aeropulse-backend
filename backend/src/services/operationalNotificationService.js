const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const User = require("../models/User");

const canReceive = (user, type = "system") => {
  const preferences = user?.notifications?.toObject?.() || user?.notifications || {};
  // This service writes to the in-app notification centre. Push delivery is a
  // separate channel and must not override an explicit in-app opt-out.
  if (preferences.inApp === false) return false;
  if (["order", "payment", "delivery"].includes(type) && preferences.orderUpdates === false) return false;
  if (["account", "security"].includes(type) && preferences.accountUpdates === false) return false;
  if (["technician", "service", "warranty"].includes(type) && preferences.serviceUpdates === false) return false;
  if (["system", "inventory", "report"].includes(type) && preferences.systemAlerts === false) return false;
  return true;
};

const createDedupedNotification = async (payload = {}, { dedupeMinutes = 60 } = {}) => {
  if (!payload.user || !mongoose.Types.ObjectId.isValid(String(payload.user))) return null;
  const dedupeKey = String(payload.dedupeKey || "").trim();
  const notificationPayload = {
    branch: "",
    type: "system",
    category: "",
    severity: "info",
    targetId: "",
    targetType: "",
    route: "",
    unread: true,
    status: "unread",
    ...payload,
    dedupeKey,
  };
  if (dedupeKey) {
    const query = {
      user: payload.user,
      dedupeKey,
    };
    if (Number(dedupeMinutes) !== 0) {
      query.createdAt = { $gte: new Date(Date.now() - Math.max(1, Number(dedupeMinutes || 60)) * 60 * 1000) };
    }
    const existing = await Notification.findOne(query).sort({ createdAt: -1 });
    if (existing) {
      const refreshFields = [
        "branch", "type", "category", "severity", "title", "message",
        "targetId", "targetType", "route",
      ];
      const contentChanged = refreshFields.some((field) => (
        String(existing[field] || "") !== String(notificationPayload[field] || "")
      ));
      if (contentChanged) {
        for (const field of refreshFields) existing[field] = notificationPayload[field] || "";
        existing.unread = true;
        existing.status = "unread";
        existing.archivedAt = null;
        await existing.save();
      }
      existing.$locals.wasDeduplicated = true;
      return existing;
    }
  }
  const created = await Notification.create(notificationPayload);
  created.$locals.wasDeduplicated = false;
  return created;
};

const notifyOperationalStaff = async ({
  branch = "",
  branches = [],
  title,
  message,
  type = "system",
  category = "",
  severity = "info",
  targetId = "",
  targetType = "",
  route = "",
  dedupeKey = "",
  dedupeMinutes = 60,
  roles = ["admin", "superadmin"],
} = {}) => {
  if (!title || !message) return [];
  const normalizedBranches = [...new Set([branch, ...(Array.isArray(branches) ? branches : [])]
    .map(value => String(value || "").trim()).filter(Boolean))];
  const normalizedBranch = normalizedBranches[0] || "";
  const users = await User.find({
    role: { $in: roles },
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["disabled", "deleted"] },
  }).select("_id role activeBranch assignedBranch notifications");
  const recipients = users.filter((user) => {
    if (!canReceive(user, type)) return false;
    if (String(user.role || "") === "superadmin" || !normalizedBranch) return true;
    const assigned = String(user.activeBranch || user.assignedBranch || "").trim();
    return normalizedBranches.includes(assigned);
  });
  return Promise.all(
    recipients.map((user) =>
      createDedupedNotification({
        user: user._id,
        branch: normalizedBranches.includes(String(user.activeBranch || user.assignedBranch || "").trim())
          ? String(user.activeBranch || user.assignedBranch).trim()
          : normalizedBranch,
        type,
        category,
        severity,
        title,
        message,
        targetId: String(targetId || ""),
        targetType,
        route,
        dedupeKey: dedupeKey ? `${dedupeKey}:${user._id}` : "",
      }, { dedupeMinutes }),
    ),
  );
};

module.exports = { canReceive, createDedupedNotification, notifyOperationalStaff };
