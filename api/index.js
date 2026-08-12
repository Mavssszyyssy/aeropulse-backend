const app = require("../src/app");
const connectDb = require("../src/config/db");
const { seedDemoUsers } = require("../src/seed/seedDemoUsers");
const { seedDashboardData } = require("../src/seed/seedDashboardData");

let initialization;

const initialize = async () => {
  if (!initialization) {
    initialization = (async () => {
      await connectDb();
      await seedDemoUsers();
      await seedDashboardData();
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
};

module.exports = async (req, res) => {
  try {
    await initialize();
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (["/", "/api", "/api/index"].includes(path)) {
      return res.json({
        service: "aeropulse-api",
        status: "ok",
        health: "/api/health",
      });
    }
    return app(req, res);
  } catch (error) {
    console.error("Vercel API initialization failed:", error);
    return res.status(503).json({
      message: "Database is temporarily unavailable. Please retry shortly.",
    });
  }
};
