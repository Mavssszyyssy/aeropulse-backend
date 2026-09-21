const User = require("../models/User");

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_SEND_TIMEOUT_MS = 4000;

function resolveRoute(notification, role) {
  const explicitRoute = String(notification.route || "");
  if (role === "technician") {
    if (explicitRoute.startsWith("/technician/task/")) return explicitRoute;
    if (notification.targetType === "task" && notification.targetId) {
      return `/technician/task/${encodeURIComponent(notification.targetId)}/information`;
    }
    return explicitRoute.startsWith("/technician/") ? explicitRoute : "/technician/tasks";
  }
  if (notification.targetType === "service_request") return "/customer/services";
  if (notification.targetType === "unit" || ["maintenance_due", "amp_due_soon", "amp_overdue"].includes(notification.category)) {
    return notification.targetId ? `/customer/units/${encodeURIComponent(notification.targetId)}` : "/customer/units";
  }
  if (role === "customer") {
    if (explicitRoute === "/customer/service-requests") return "/customer/services";
    if (explicitRoute === "/contact") return "/customer/contact";
    if (explicitRoute === "/my-orders") return "/customer/orders";
    if (explicitRoute === "/myunit" || explicitRoute.startsWith("/myunit/")) return "/customer/units";
    if (explicitRoute === "/settings") return "/customer/settings";
  }
  if (explicitRoute) return explicitRoute;

  const text = `${notification.title || ""} ${notification.message || ""}`.toLowerCase();
  if (role === "technician") {
    if (text.includes("part")) return "/technician/tasks";
    if (notification.type === "order" || text.includes("task") || text.includes("order")) {
      return "/technician/tasks";
    }
    return "/technician/dashboard";
  }
  if (text.includes("service") || text.includes("appointment") || text.includes("request")) {
    return "/customer/services";
  }
  if (notification.type === "order" || text.includes("order")) return "/customer/orders";
  if (notification.type === "account") return "/customer/settings";
  return "/customer/home";
}

function canReceivePush(user, type = "system") {
  const preferences = user?.notifications?.toObject?.() || user?.notifications || {};
  if (preferences.push === false) return false;
  if (["order", "payment", "delivery"].includes(type) && preferences.orderUpdates === false) return false;
  if (["account", "security"].includes(type) && preferences.accountUpdates === false) return false;
  if (["technician", "service", "warranty"].includes(type) && preferences.serviceUpdates === false) return false;
  if (["system", "inventory", "report"].includes(type) && preferences.systemAlerts === false) return false;
  return true;
}

async function sendPushForNotification(notification, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PUSH_SEND_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") return;

  const user = await User.findById(notification.user).select("expoPushTokens notifications role");
  if (!user || !canReceivePush(user, notification.type)) return;

  const tokens = [...new Set(user.expoPushTokens || [])].filter((token) =>
    /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token),
  );
  if (!tokens.length) return;

  const messages = tokens.map((to) => ({
    to,
    sound: "default",
    title: notification.title,
    body: notification.message,
    data: {
      notificationId: String(notification._id),
      route: resolveRoute(notification, String(user.role || "customer").toLowerCase()),
      type: notification.type,
    },
  }));

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || PUSH_SEND_TIMEOUT_MS))
    : null;
  try {
    const response = await fetchImpl(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) throw new Error(`Expo push service returned ${response.status}`);
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error("Expo push delivery timed out; the in-app notification remains saved.");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { PUSH_SEND_TIMEOUT_MS, canReceivePush, resolveRoute, sendPushForNotification };
