const mongoose = require("mongoose");
const env = require("./env");

const buildDirectMongoUri = ({ mongoUri = "", directHosts = "", replicaSet = "" } = {}) => {
  const normalizedDirectHosts = String(directHosts || "").trim();
  if (!normalizedDirectHosts || !String(mongoUri || "").startsWith("mongodb+srv://")) {
    return mongoUri;
  }

  const source = new URL(mongoUri);
  const options = new URLSearchParams(source.search);
  options.set("tls", "true");
  if (replicaSet) options.set("replicaSet", replicaSet);
  if (!options.has("authSource")) options.set("authSource", "admin");

  const credentials = source.username
    ? `${source.username}${source.password ? `:${source.password}` : ""}@`
    : "";
  const databasePath = source.pathname && source.pathname !== "/" ? source.pathname : "/";
  return `mongodb://${credentials}${normalizedDirectHosts}${databasePath}?${options.toString()}`;
};

const buildMongoUri = () => buildDirectMongoUri({
  mongoUri: env.mongoUri,
  directHosts: env.mongoDirectHosts,
  replicaSet: env.mongoReplicaSet,
});

const displayMongoTarget = (uri) => {
  try {
    return new URL(uri).host;
  } catch {
    return "configured MongoDB instance";
  }
};

const connectionOptions = {
  // Fail an affected request promptly rather than buffering it indefinitely
  // after Atlas closes an idle serverless connection.
  bufferCommands: false,
  serverSelectionTimeoutMS: 7000,
  connectTimeoutMS: 7000,
  socketTimeoutMS: 15000,
  maxPoolSize: 10,
  minPoolSize: 0,
};

const PING_INTERVAL_MS = 15000;
const PING_TIMEOUT_MS = 2500;

const pingConnection = async () => {
  const connection = mongoose.connection;
  if (connection.readyState !== 1 || !connection.db) return false;
  const ping = connection.db.admin().ping();
  await Promise.race([
    ping,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MongoDB heartbeat timed out.")), PING_TIMEOUT_MS),
    ),
  ]);
  return true;
};

const ensureConnection = async () => {
  if (mongoose.connection.readyState === 1) {
    const now = Date.now();
    const lastPing = Number(global.__aeropulseMongoLastPingAt || 0);
    if (now - lastPing < PING_INTERVAL_MS) return mongoose.connection;
    try {
      await pingConnection();
      global.__aeropulseMongoLastPingAt = Date.now();
      return mongoose.connection;
    } catch (_error) {
      global.__aeropulseMongoLastPingAt = 0;
      try {
        await mongoose.disconnect();
      } catch (_disconnectError) {
        // Reconnection below will surface the actionable error if needed.
      }
    }
  }
  const mongoUri = buildMongoUri();

  try {
    // If Mongoose was already connecting before this module acquired the
    // shared readiness lock, wait for that attempt instead of starting a
    // competing connection.
    if (mongoose.connection.readyState === 2) {
      try {
        await mongoose.connection.asPromise();
        if (mongoose.connection.readyState === 1) return mongoose.connection;
      } catch (_error) {
        // The attempt failed; mongoose is now safe to reconnect.
      }
    }

    await mongoose.connect(mongoUri, connectionOptions);
    if (mongoose.connection.readyState !== 1) {
      throw new Error("MongoDB connection did not reach the connected state.");
    }
    global.__aeropulseMongoLastPingAt = Date.now();
    console.log(`MongoDB connected: ${displayMongoTarget(mongoUri)}`);
    return mongoose.connection;
  } catch (error) {
    console.error(`Failed to connect to MongoDB at ${displayMongoTarget(mongoUri)}`);
    console.error("Start MongoDB or set MONGODB_URI in backend/.env to a reachable database.");
    throw error;
  }
};

const connectDb = async () => {
  // Customer and Technician dashboards load several endpoints together.
  // A single warm Vercel function must perform exactly one ping/reconnect
  // sequence; otherwise concurrent requests can disconnect a socket while a
  // sibling request is using it and all requests eventually hit 504.
  if (global.__aeropulseMongoReadiness) {
    return global.__aeropulseMongoReadiness;
  }

  const readiness = ensureConnection().finally(() => {
    if (global.__aeropulseMongoReadiness === readiness) {
      global.__aeropulseMongoReadiness = null;
    }
  });
  global.__aeropulseMongoReadiness = readiness;
  return readiness;
};

module.exports = connectDb;
module.exports.buildDirectMongoUri = buildDirectMongoUri;
