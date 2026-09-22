const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoose = require("mongoose");
const env = require("./config/env");
const { getResendEmailConfiguration } = require("./utils/email");
const { createMemoryRateLimit } = require("./middleware/requestRateLimit");
const { httpErrorHandler } = require("./middleware/httpErrorHandler");

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
const warrantyRoutes = require("./routes/warrantyRoutes");
const branchCoverageRoutes = require("./routes/branchCoverageRoutes");
const contactMessageRoutes = require("./routes/contactMessageRoutes");
const securityRoutes = require("./routes/securityRoutes");
const cronRoutes = require("./routes/cronRoutes");

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

// Every API response is live account/operations data. Express ETags allowed
// Vercel/mobile clients to revalidate these responses as 304, which can leave
// Expo Go screens without a response body after a long session. Never cache
// authenticated dashboard, task, notification, order, or unit responses.
app.disable("etag");
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// Only registration and recovery endpoints use server-side session data.
// Keeping this store off ordinary token-authenticated API requests prevents a
// stale session-store socket from delaying Admin, order, and catalog screens.
const authSession = session({
  name: "aeropulse.sid",
  secret: env.jwtSecret,
  resave: false,
  saveUninitialized: false,
  store: env.mongoUri
    ? MongoStore.create({
        mongoUrl: env.mongoUri,
        collectionName: "sessions",
        ttl: 24 * 60 * 60,
        autoRemove: "native",
        mongoOptions: {
          serverSelectionTimeoutMS: 10000,
          connectTimeoutMS: 10000,
          socketTimeoutMS: 45000,
        },
      })
    : undefined,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  },
});

app.use(cookieParser(env.jwtSecret));
// Preserve the exact request bytes for PayMongo webhook signature
// verification. JSON parsing normalizes whitespace and key ordering, so a
// parsed object cannot be used to authenticate a webhook safely.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  }),
);

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    status: "ok",
    service: "aeropulse-api",
    environment: env.nodeEnv,
    release: String(process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7),
    ...(isProduction || mongoose.connection.readyState !== 1
      ? {}
      : { databaseName: mongoose.connection.name || "" }),
    email: {
      resend: getResendEmailConfiguration(),
      smtpConfigured: Boolean(
        env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFrom,
      ),
    },
  });
});

app.use("/api/cron", cronRoutes);

app.use(
  "/api/auth",
  createMemoryRateLimit({
    scope: "auth",
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: "Too many authentication requests. Please wait and try again.",
  }),
  authSession,
  authRoutes,
);
app.use("/api/users", userRoutes);
app.use("/api/security", securityRoutes);
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
app.use(
  "/api/ai",
  createMemoryRateLimit({
    scope: "ai",
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: "AI request limit reached. Please wait before trying again.",
  }),
  aiRoutes,
);
app.use(
  "/api/amp",
  createMemoryRateLimit({
    scope: "amp",
    windowMs: 10 * 60 * 1000,
    max: 120,
    message: "AMP request limit reached. Please wait and try again.",
  }),
  ampRoutes,
);
app.use("/api/predictions", predictionRoutes);
app.use("/api/parts-requests", partsRequestRoutes);
app.use("/api/warranties", warrantyRoutes);
app.use("/api/branches", branchCoverageRoutes);
app.use("/api/contact-messages", contactMessageRoutes);

const buildPath = path.resolve(__dirname, "..", "..", "front", "build");
const indexHtml = path.join(buildPath, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(buildPath));

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next();
    }
    res.sendFile(indexHtml);
  });
}

app.use(httpErrorHandler);

app.use("/api", (_req, res) => {
  res.status(404).json({ message: "API route not found." });
});

module.exports = app;
