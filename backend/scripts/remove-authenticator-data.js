/*
 * Idempotent cleanup for deployments that previously stored authenticator
 * secrets, recovery codes, or password-reset-link state. Password hashes,
 * session version, and every unrelated account field are deliberately preserved.
 */
const mongoose = require("mongoose");
const env = require("../src/config/env");
const User = require("../src/models/User");

const OBSOLETE_AUTH_FIELDS = {
  passwordReset: "",
  "security.totpEnabled": "",
  "security.totpSecretEncrypted": "",
  "security.totpPendingSecretEncrypted": "",
  "security.totpPendingPurpose": "",
  "security.totpPendingExpiresAt": "",
  "security.totpVerifiedAt": "",
  "security.totpResetRequired": "",
  "security.recoveryCodeHashes": "",
  "security.recoveryCodesRemaining": "",
  "security.recoveryCodesGeneratedAt": "",
  "security.recoveredAt": "",
};
const matchingLegacyData = {
  $or: Object.keys(OBSOLETE_AUTH_FIELDS).map((field) => ({
    [field]: { $exists: true },
  })),
};

async function run() {
  if (!env.mongoUri) throw new Error("MONGO_URI is required.");
  await mongoose.connect(env.mongoUri);
  const matchedCount = await User.collection.countDocuments(matchingLegacyData);
  if (!process.argv.includes("--apply")) {
    console.log(`Dry run: ${matchedCount} account(s) still contain obsolete authenticator or reset-link data.`);
    console.log("No data changed. Use --apply with CONFIRM_REMOVE_AUTHENTICATOR_DATA=REMOVE_AUTHENTICATOR_DATA to continue.");
    await mongoose.disconnect();
    return;
  }
  if (process.env.CONFIRM_REMOVE_AUTHENTICATOR_DATA !== "REMOVE_AUTHENTICATOR_DATA") {
    throw new Error("Set CONFIRM_REMOVE_AUTHENTICATOR_DATA=REMOVE_AUTHENTICATOR_DATA before applying this migration.");
  }
  const expectedDatabase = String(process.env.REMOVE_AUTHENTICATOR_EXPECTED_DATABASE || "").trim();
  if (!expectedDatabase || mongoose.connection.name !== expectedDatabase) {
    throw new Error(
      `Set REMOVE_AUTHENTICATOR_EXPECTED_DATABASE to the exact connected database name (${mongoose.connection.name}) before applying this migration.`,
    );
  }
  // Use the native collection because the removed legacy paths deliberately no
  // longer exist in the current Mongoose schema and would otherwise be stripped.
  const result = await User.collection.updateMany(
    matchingLegacyData,
    { $unset: OBSOLETE_AUTH_FIELDS },
  );
  console.log(`Authenticator cleanup complete. Matched ${result.matchedCount}; updated ${result.modifiedCount}.`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("Authenticator cleanup failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
