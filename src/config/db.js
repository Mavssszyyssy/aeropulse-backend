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
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 0,
};

const connectDb = async () => {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
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
