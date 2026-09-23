const env = require("../config/env");
const { runAmpDailyMonitor } = require("../services/ampDailyMonitorService");
const { runRequiredActionReminderSweep } = require("../services/requiredActionReminderService");

const isAuthorizedCronRequest = (authorization = "", secret = env.cronSecret) =>
  Boolean(secret) && String(authorization || "") === `Bearer ${secret}`;

const runDailyAmpMaintenance = async (req, res) => {
  if (!env.cronSecret) return res.status(503).json({ message: "Scheduled monitoring is not configured." });
  if (!isAuthorizedCronRequest(req.get("authorization"))) return res.status(401).json({ message: "Unauthorized." });
  try {
    const stats = await runAmpDailyMonitor();
    return res.json({ status: "completed", ...stats });
  } catch (error) {
    console.error("AMP daily monitor failed:", error.message);
    return res.status(500).json({ message: "AMP daily monitoring could not be completed." });
  }
};

const runRequiredActionReminders = async (req, res) => {
  if (!env.cronSecret) return res.status(503).json({ message: "Scheduled monitoring is not configured." });
  if (!isAuthorizedCronRequest(req.get("authorization"))) return res.status(401).json({ message: "Unauthorized." });
  try {
    const stats = await runRequiredActionReminderSweep();
    return res.json({ status: "completed", ...stats });
  } catch (error) {
    console.error("Required-action reminder sweep failed:", error.message);
    return res.status(500).json({ message: "Required-action reminders could not be completed." });
  }
};

module.exports = { isAuthorizedCronRequest, runDailyAmpMaintenance, runRequiredActionReminders };
