// Load .env from the backend folder (one level up from src)
const path = require("path");
const os = require("os");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = require("./app");
const env = require("./config/env");
const connectDb = require("./config/db");
const { seedDemoUsers } = require("./seed/seedDemoUsers");
const { seedDashboardData } = require("./seed/seedDashboardData");

// Debug - check if it loaded
console.log("MONGODB_URI loaded:", process.env.MONGODB_URI ? "YES" : "NO");

// Global error handlers to prevent crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Allow process to continue instead of crashing
});

const start = async () => {
  try {
    await connectDb();
    await seedDemoUsers();
    await seedDashboardData();

    const server = app.listen(env.port, env.host, () => {
      const lanAddresses = Object.values(os.networkInterfaces())
        .flat()
        .filter(
          (networkInterface) =>
            networkInterface &&
            networkInterface.family === "IPv4" &&
            !networkInterface.internal,
        )
        .map((networkInterface) => networkInterface.address);

      console.log(`Backend running on http://localhost:${env.port}`);
      lanAddresses.forEach((address) => {
        console.log(`Backend LAN URL: http://${address}:${env.port}`);
      });
    });

    // Handle server errors
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(
          `Port ${env.port} is already in use. Please free up the port or use a different one.`,
        );
        console.error("Attempting to use alternative port...");
        // Try alternative port
        const altPort = parseInt(env.port) + 1;
        const altServer = app.listen(altPort, env.host, () => {
          console.log(
            `Backend running on http://localhost:${altPort} (alternative port)`,
          );
        });
        altServer.on("error", (err) => {
          console.error("Failed to start on alternative port:", err);
          process.exit(1);
        });
      } else {
        console.error("Server error:", error);
        process.exit(1);
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

start();
