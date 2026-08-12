const User = require("../models/User");

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

function resolveRoute(notification, role) {
  if (notification.route) return notification.route;

  const text = `${notification.title || ""} ${notification.message || ""}`.toLowerCase();
  if (role === "technician") {
    if (text.includes("part")) return "/technician/parts";
    if (notification.type === "order" || text.includes("task") || text.includes("order")) {
      return "/technician/tasks";
    }
    return "/technician/dashboard";
  }
  if (text.includes("service") || text.includes("appointment") || text.includes("request")) {
    return "/customer/requests";
  }
  if (notification.type === "order" || text.includes("order")) return "/customer/orders";
  if (notification.type === "account") return "/customer/settings";
  return "/customer/home";
}

async function sendPushForNotification(notification) {
  if (typeof fetch !== "function") return;

  const user = await User.findById(notification.user).select("expoPushTokens notifications.push role");
  if (!user || user.notifications?.push === false) return;

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

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!response.ok) throw new Error(`Expo push service returned ${response.status}`);
}

module.exports = { sendPushForNotification };
