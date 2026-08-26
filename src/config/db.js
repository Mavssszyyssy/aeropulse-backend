const mongoose = require("mongoose");
const env = require("./env");

const buildMongoUri = () => {
  const directHosts = String(env.mongoDirectHosts || "").trim();
  if (!directHosts || !String(env.mongoUri || "").startsWith("mongodb+srv://")) {
    return env.mongoUri;
  }

  const source = new URL(env.mongoUri);
  const options = new URLSearchParams(source.search);
  options.set("tls", "true");
  if (env.mongoReplicaSet) options.set("replicaSet", env.mongoReplicaSet);
  if (!options.has("authSource")) options.set("authSource", "admin");

  const credentials = source.username
    ? `${source.username}${source.password ? `:${source.password}` : ""}@`
    : "";
  return `mongodb://${credentials}${directHosts}/?${options.toString()}`;
};

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

const connectDb = async () => {
  if (mongoose.connection.readyState === 1) {
    const now = Date.now();
    const lastPing = Number(global.__aeropulseMongoLastPingAt || 0);
    if (now - lastPing < PING_INTERVAL_MS) return mongoose.connection;
    if (global.__aeropulseMongoPing) {
      try {
        await global.__aeropulseMongoPing;
        return mongoose.connection;
      } catch (_error) {
        // The heartbeat failed; close the stale socket and reconnect below.
      }
    }
    global.__aeropulseMongoPing = pingConnection()
      .then(() => {
        global.__aeropulseMongoLastPingAt = Date.now();
      })
      .finally(() => {
        global.__aeropulseMongoPing = null;
      });
    try {
      await global.__aeropulseMongoPing;
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
    // A previously resolved promise is only valid while the underlying
    // connection remains open. Warm Vercel instances can outlive an Atlas
    // socket, so discard the stale cache and reconnect when needed.
    if (global.__aeropulseMongoConnection) {
      try {
        await global.__aeropulseMongoConnection;
        if (mongoose.connection.readyState === 1) return mongoose.connection;
      } catch (_error) {
        // Create a fresh connection below.
      }
      global.__aeropulseMongoConnection = null;
    }

    // If another request started connecting before the cache was created,
    // wait for that connection before opening a second one.
    if (mongoose.connection.readyState === 2) {
      try {
        await mongoose.connection.asPromise();
        if (mongoose.connection.readyState === 1) return mongoose.connection;
      } catch (_error) {
        // The attempt failed; mongoose is now safe to reconnect.
      }
    }

    global.__aeropulseMongoConnection = mongoose
      .connect(mongoUri, connectionOptions)
      .then((instance) => {
        if (mongoose.connection.readyState !== 1) {
          throw new Error("MongoDB connection did not reach the connected state.");
        }
        return instance;
      });

    await global.__aeropulseMongoConnection;
    console.log(`MongoDB connected: ${displayMongoTarget(mongoUri)}`);
    return mongoose.connection;
  } catch (error) {
    global.__aeropulseMongoConnection = null;
    console.error(`Failed to connect to MongoDB at ${displayMongoTarget(mongoUri)}`);
    console.error("Start MongoDB or set MONGODB_URI in backend/.env to a reachable database.");
    throw error;
  }
};

module.exports = connectDb;
