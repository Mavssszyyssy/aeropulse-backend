const app = require("../src/app");
const connectDb = require("../src/config/db");
const env = require("../src/config/env");
const { seedDemoUsers } = require("../src/seed/seedDemoUsers");
const { seedDashboardData } = require("../src/seed/seedDashboardData");
const { restoreDemoStaff } = require("../src/seed/restoreDemoStaff");

let initialization;

const initialize = async () => {
  if (!initialization) {
    initialization = (async () => {
      await connectDb();
      if (env.nodeEnv !== "production" && process.env.SEED_DEMO_DATA !== "false") {
        await seedDemoUsers();
        await seedDashboardData();
      }
      // Production demo data stays disabled. This opt-in recovery switch only
      // restores the original Admin and SuperAdmin accounts when they are
      // missing; it never changes existing users or operational records.
      if (String(process.env.RESTORE_DEMO_STAFF || "").toLowerCase() === "true") {
        const restored = await restoreDemoStaff();
        console.info("Demo staff recovery completed:", restored);
      }
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
};

module.exports = async (req, res) => {
  try {
    // Vercel rewrites all API paths to this serverless function. Restore the
    // original Express path so routes such as /api/products/public work.
    const incomingUrl = new URL(req.url || "/", "http://localhost");
    const rewrittenRoute = incomingUrl.searchParams.get("__route");
    if (rewrittenRoute) {
      incomingUrl.searchParams.delete("__route");
      const normalizedRoute = String(rewrittenRoute).replace(/^\/+/, "");
      req.url = `/api/${normalizedRoute}${incomingUrl.search}`;
    }

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
