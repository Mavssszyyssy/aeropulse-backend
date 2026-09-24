const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const expectedDatabase = String(process.env.ACCEPTANCE_EXPECTED_DATABASE || "").trim();
assert.match(
  expectedDatabase,
  /(?:_qa|_e2e)$/i,
  "ACCEPTANCE_EXPECTED_DATABASE must name an isolated database ending in _qa or _e2e.",
);
const configuredMongoUri = String(process.env.MONGODB_URI || "").trim();
assert.match(configuredMongoUri, /^mongodb(?:\+srv)?:\/\//i, "A MongoDB URI is required for isolated QA.");
const qaMongoUri = new URL(configuredMongoUri);
qaMongoUri.pathname = `/${expectedDatabase}`;
process.env.MONGODB_URI = qaMongoUri.toString();

const connectDb = require("../../src/config/db");
const User = require("../../src/models/User");
const { signUserAccessToken } = require("../../src/utils/token");
const { canonicalizePhMobile, isValidPhMobile } = require("../../src/utils/phMobile");

let connectionPromise = null;

const normalized = (value = "") => String(value).trim().toLowerCase();
const isEmail = (value = "") => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const ensureIsolatedDatabase = async () => {
  if (!connectionPromise) connectionPromise = connectDb();
  await connectionPromise;
  assert.equal(
    normalized(mongoose.connection.name),
    expectedDatabase,
    "The direct QA session database does not match ACCEPTANCE_EXPECTED_DATABASE.",
  );
};

const findUniqueQaAccount = async (identifier = "") => {
  const value = normalized(identifier);
  const phone = canonicalizePhMobile(identifier);
  const uniqueConditions = [{ alias: value }, { username: value }];
  if (isValidPhMobile(phone)) uniqueConditions.push({ phone });

  const direct = await User.findOne({ $or: uniqueConditions });
  if (direct) return direct;
  if (!isEmail(value)) return null;

  const matches = await User.find({ email: value }).limit(2);
  assert.ok(
    matches.length < 2,
    "Shared email addresses are ambiguous. Use the account's unique login ID in QA scripts.",
  );
  return matches[0] || null;
};

// These destructive walkthroughs validate business workflows against a local,
// isolated database. Automated authentication tests validate the real
// password -> email-code exchange. Minting the post-verification session here
// prevents walkthroughs from sending real email or exposing verification codes.
const createIsolatedQaSession = async (identifier, password) => {
  await ensureIsolatedDatabase();
  const user = await findUniqueQaAccount(identifier);
  const passwordMatches = Boolean(
    user?.passwordHash && await bcrypt.compare(String(password || ""), user.passwordHash),
  );
  if (!passwordMatches) {
    const error = new Error("Invalid QA credentials");
    error.status = 401;
    throw error;
  }
  assert.ok(
    !user.isDeleted && !["disabled", "deleted"].includes(String(user.accountStatus || "")),
    "The requested QA account is not active.",
  );
  return {
    token: signUserAccessToken(user),
    user: user.toJSON(),
  };
};

const closeIsolatedQaSession = async () => {
  connectionPromise = null;
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

module.exports = {
  closeIsolatedQaSession,
  createIsolatedQaSession,
};
