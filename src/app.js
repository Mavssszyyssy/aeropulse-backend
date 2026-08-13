const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const helmet = require("helmet");
const morgan = require("morgan");
const env = require("./config/env");
const { getInfobipEmailConfiguration } = require("./utils/email");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const productRoutes = require("./routes/productRoutes");
const reorderRoutes = require("./routes/reorderRoutes");
const serviceRequestRoutes = require("./routes/serviceRequestRoutes");
const orderRoutes = require("./routes/orderRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const taskRoutes = require("./routes/taskRoutes");
const inventoryChangeRequestRoutes = require("./routes/inventoryChangeRequestRoutes");
const restockOrderRoutes = require("./routes/restockOrderRoutes");
const reportRoutes = require("./routes/reportRoutes");
const aiRoutes = require("./routes/aiRoutes");
const ampRoutes = require("./routes/ampRoutes");
const predictionRoutes = require("./routes/predictionRoutes");
const partsRequestRoutes = require("./routes/partsRequestRoutes");

const app = express();
const isProduction = env.nodeEnv === "production";

// Vercel terminates HTTPS at its proxy. Trust the forwarded protocol so secure
// cross-site session cookies can be issued to the deployed web application.
if (isProduction) app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigin,
    credentials: true,
  }),
);
app.use(morgan("dev"));

// Switch to express-session for server-side persistence
// This ensures server restarts wipe all sessions (default in-memory store)
app.use(
  session({
    name: "aeropulse.sid",
    secret: env.jwtSecret,
    resave: false,
    saveUninitialized: false,
    // Serverless instances do not share express-session's memory store.
    store: env.mongoUri
      ? MongoStore.create({
          mongoUrl: env.mongoUri,
          collectionName: "sessions",
          ttl: 24 * 60 * 60,
          autoRemove: "native",
        })
      : undefined,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
    },
  }),
);

app.use(cookieParser(env.jwtSecret));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "aeropulse-api",
    environment: env.nodeEnv,
    email: {
      infobip: getInfobipEmailConfiguration(),
      smtpConfigured: Boolean(
        env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFrom,
      ),
    },
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/products", productRoutes);
app.use("/api/reorders", reorderRoutes);
app.use("/api/service-requests", serviceRequestRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/inventory-change-requests", inventoryChangeRequestRoutes);
app.use("/api/restock-orders", restockOrderRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/amp", ampRoutes);
app.use("/api/predictions", predictionRoutes);
app.use("/api/parts-requests", partsRequestRoutes);

const buildPath = path.resolve(__dirname, "..", "..", "front", "build");
const indexHtml = path.join(buildPath, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(buildPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next();
    }
    res.sendFile(indexHtml);
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found." });
});

module.exports = app;
