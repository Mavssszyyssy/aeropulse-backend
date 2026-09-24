require("dotenv").config();
const mongoose = require("mongoose");
const {
  SHARED_DEMO_ACCOUNTS,
  SHARED_DEMO_EMAIL,
  buildEmailIdentityKey,
  sharedDemoAccount,
} = require("../src/domain/demoStaffPolicy");

const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes(`--confirm=${SHARED_DEMO_EMAIL}`);

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
const accountKey = (user = {}) => String(user.alias || user.username || "").trim().toLowerCase();

const loadTargets = async (users) => {
  const rows = await users.find({
    $or: SHARED_DEMO_ACCOUNTS.flatMap(({ accountKey: key }) => [
      { alias: key },
      { username: key },
    ]),
    isDeleted: { $ne: true },
    accountStatus: { $ne: "deleted" },
  }).toArray();
  const byKey = new Map(rows.map((user) => [accountKey(user), user]));
  const targets = SHARED_DEMO_ACCOUNTS.map((expected) => byKey.get(expected.accountKey));
  if (targets.some((target) => !target)) {
    const missing = SHARED_DEMO_ACCOUNTS
      .filter((expected) => !byKey.has(expected.accountKey))
      .map((expected) => expected.accountKey);
    throw new Error(`Missing required demo accounts: ${missing.join(", ")}`);
  }
  for (const target of targets) {
    if (!sharedDemoAccount(target)) {
      throw new Error(`Role or branch mismatch for ${accountKey(target)}; no data was changed.`);
    }
  }
  if (new Set(targets.map((target) => String(target._id))).size !== SHARED_DEMO_ACCOUNTS.length) {
    throw new Error("The five demo aliases do not resolve to five separate account IDs.");
  }
  return targets;
};

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  if (apply && !confirmed) {
    throw new Error(`Apply mode requires --confirm=${SHARED_DEMO_EMAIL}`);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const users = mongoose.connection.db.collection("users");
  const targets = await loadTargets(users);
  const allWithEmail = await users.find({ email: { $type: "string", $ne: "" } }).toArray();
  const identityRows = allWithEmail.map((user) => ({
    id: user._id,
    emailIdentityKey: buildEmailIdentityKey(user, user.email),
  }));
  const seen = new Map();
  for (const row of identityRows) {
    const previous = seen.get(row.emailIdentityKey);
    if (previous) {
      throw new Error(`Duplicate non-exempt email identity detected for ${row.emailIdentityKey}. Resolve it before migrating.`);
    }
    seen.set(row.emailIdentityKey, String(row.id));
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    database: mongoose.connection.name,
    sharedEmail: SHARED_DEMO_EMAIL,
    accounts: targets.map((target) => ({
      id: String(target._id),
      accountKey: accountKey(target),
      role: target.role,
      branch: target.assignedBranch || target.activeBranch || "",
      currentEmail: normalizeEmail(target.email),
    })),
  };
  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (identityRows.length) {
    await users.bulkWrite(identityRows.map((row) => ({
      updateOne: {
        filter: { _id: row.id },
        update: { $set: { emailIdentityKey: row.emailIdentityKey } },
      },
    })), { ordered: true });
  }
  await users.createIndex(
    { emailIdentityKey: 1 },
    { unique: true, sparse: true, name: "emailIdentityKey_1" },
  );

  const indexes = await users.indexes();
  const legacyEmailIndex = indexes.find((index) => (
    index.unique === true &&
    Object.keys(index.key || {}).length === 1 &&
    index.key?.email === 1
  ));
  if (legacyEmailIndex) await users.dropIndex(legacyEmailIndex.name);

  const securityBefore = new Map(targets.map((target) => [
    String(target._id),
    JSON.stringify(target.security || {}),
  ]));
  await users.bulkWrite(targets.map((target) => ({
    updateOne: {
      filter: { _id: target._id },
      update: {
        $set: {
          email: SHARED_DEMO_EMAIL,
          emailIdentityKey: buildEmailIdentityKey(target, SHARED_DEMO_EMAIL),
        },
      },
    },
  })), { ordered: true });

  const verified = await users.find({ _id: { $in: targets.map((target) => target._id) } }).toArray();
  for (const target of verified) {
    if (normalizeEmail(target.email) !== SHARED_DEMO_EMAIL) throw new Error(`Email verification failed for ${accountKey(target)}.`);
    if (securityBefore.get(String(target._id)) !== JSON.stringify(target.security || {})) {
      throw new Error(`Security data changed unexpectedly for ${accountKey(target)}.`);
    }
  }
  report.verifiedSeparateAccountIds = new Set(verified.map((target) => String(target._id))).size;
  report.legacyEmailIndexRemoved = Boolean(legacyEmailIndex);
  report.emailIdentityIndex = "emailIdentityKey_1";
  console.log(JSON.stringify(report, null, 2));
};

run()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(error.message);
    try { await mongoose.disconnect(); } catch (_disconnectError) {}
    process.exit(1);
  });
