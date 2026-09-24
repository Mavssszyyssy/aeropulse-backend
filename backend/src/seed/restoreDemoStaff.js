const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { demoUsers } = require("./seedDemoUsers");

// Controlled production recovery for the original seeded staff only. Existing
// active accounts are never updated. A matching soft-deleted seed can be
// restored in place so references to its original user id remain valid.
const demoStaff = demoUsers.filter((user) =>
  ["admin", "superadmin", "technician"].includes(user.role),
);

const matchesIdentity = (user, staff) =>
  String(user.email || "").toLowerCase() === staff.email ||
  String(user.alias || "").toLowerCase() === staff.alias ||
  String(user.phone || "") === staff.phone;

const restoreDemoStaff = async () => {
  const identities = demoStaff.flatMap((staff) => [
    { email: staff.email },
    { alias: staff.alias },
    { phone: staff.phone },
  ]);
  const existingUsers = await User.find({ $or: identities })
    .select("email alias phone role accountStatus isDeleted");

  const conflicts = demoStaff.filter((staff) => {
    const matches = existingUsers.filter((user) => matchesIdentity(user, staff));
    return matches.some((user) => {
      const exactActiveIdentity =
        (String(user.email || "").toLowerCase() === staff.email ||
          String(user.alias || "").toLowerCase() === staff.alias) &&
        user.role === staff.role &&
        !user.isDeleted &&
        user.accountStatus !== "deleted";
      const restorableSeed =
        String(user.alias || "").toLowerCase() === staff.alias &&
        user.role === staff.role &&
        (user.isDeleted || user.accountStatus === "deleted");
      return !exactActiveIdentity && !restorableSeed;
    });
  });

  if (conflicts.length) {
    throw new Error(
      `Cannot restore demo staff because an alias or phone number is already in use for: ${conflicts
        .map((staff) => staff.role)
        .join(", ")}.`,
    );
  }

  const result = { created: [], restored: [], existing: [] };
  for (const staff of demoStaff) {
    const existing = existingUsers.find(
      (user) =>
        (String(user.email || "").toLowerCase() === staff.email ||
          String(user.alias || "").toLowerCase() === staff.alias) &&
        user.role === staff.role &&
        !user.isDeleted &&
        user.accountStatus !== "deleted",
    );
    if (existing) {
      result.existing.push(staff.alias);
      continue;
    }

    const configuredPassword = staff.role === "superadmin"
      ? process.env.SEED_SUPERADMIN_PASSWORD
      : staff.role === "technician"
        ? process.env.SEED_TECHNICIAN_PASSWORD || process.env.SEED_ADMIN_PASSWORD
        : process.env.SEED_ADMIN_PASSWORD;
    const passwordHash = await bcrypt.hash(configuredPassword || staff.password, 10);
    const { password: _seedPassword, ...account } = staff;
    const deletedSeed = existingUsers.find(
      (user) =>
        String(user.alias || "").toLowerCase() === staff.alias &&
        user.role === staff.role &&
        (user.isDeleted || user.accountStatus === "deleted"),
    );

    if (deletedSeed) {
      Object.assign(deletedSeed, account, {
        passwordHash,
        accountStatus: "active",
        isDeleted: false,
        deletedAt: null,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        isFirstLogin: staff.alias !== "tech.main",
      });
      await deletedSeed.save();
      result.restored.push(staff.alias);
      continue;
    }

    await User.create({
      ...account,
      passwordHash,
      isFirstLogin: staff.alias !== "tech.main",
    });
    result.created.push(staff.alias);
  }

  return result;
};

module.exports = { restoreDemoStaff };
