const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const { sendPushForNotification } = require("../src/services/pushNotificationService");

test("slow Expo push delivery cannot hold an operational write indefinitely", async (t) => {
  const originalFindById = User.findById;
  User.findById = () => ({
    select: async () => ({
      role: "customer",
      notifications: {},
      expoPushTokens: ["ExponentPushToken[test-device]"],
    }),
  });
  t.after(() => { User.findById = originalFindById; });

  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  await assert.rejects(
    sendPushForNotification({
      user: "66f0f2f46d3a2e0012345678",
      title: "Work completed",
      message: "The synchronized task is complete.",
      type: "service",
      route: "/customer/services",
    }, { fetchImpl, timeoutMs: 5 }),
    /timed out.*in-app notification remains saved/i,
  );
});
