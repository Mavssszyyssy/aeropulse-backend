const LOCAL_MONGO_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLocalMongoUri = (mongoUri = "") => {
  try {
    const parsed = new URL(mongoUri);
    return parsed.protocol === "mongodb:" && LOCAL_MONGO_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const shouldSeedDemoData = ({ flag, mongoUri, nodeEnv } = {}) => {
  if (flag !== "true") return false;
  if (nodeEnv === "production" || !isLocalMongoUri(mongoUri)) {
    throw new Error("Demo seeding requires a local MongoDB URI and a non-production environment.");
  }
  return true;
};

module.exports = { isLocalMongoUri, shouldSeedDemoData };
