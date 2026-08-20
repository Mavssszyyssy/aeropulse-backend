const bcrypt = require("bcryptjs");
const User = require("../models/User");

// This is deliberately limited to the two original demo staff accounts. It is
// used only for controlled production recovery and never updates an existing
// account, password, order, product, or customer record.
const demoStaff = [
  {
    email: "admin@example.com",
    alias: "admin.main",
    password: "admin123",
    name: "Admin User",
    name_first: "Admin",
    name_last: "User",
    phone: "09123456780",
    address: "456 Admin Street",
    role: "admin",
    assignedBranch: "Bulacan",
    activeBranch: "Bulacan",
  },
  {
    email: "superadmin@example.com",
    alias: "superadmin.main",
    password: "admin123",
    name: "Super Admin",
    name_first: "Super",
    name_last: "Admin",
    phone: "09123456799",
    address: "Global Headquarters",
    role: "superadmin",
  },
];

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
    .select("email alias phone role")
    .lean();

  const conflicts = demoStaff.filter((staff) => {
    const matches = existingUsers.filter((user) => matchesIdentity(user, staff));
    return matches.some(
      (user) => String(user.email || "").toLowerCase() !== staff.email,
    );
  });

  if (conflicts.length) {
    throw new Error(
      `Cannot restore demo staff because an alias or phone number is already in use for: ${conflicts
        .map((staff) => staff.role)
        .join(", ")}.`,
    );
  }

  const result = { created: [], existing: [] };
  for (const staff of demoStaff) {
    const exists = existingUsers.some(
      (user) => String(user.email || "").toLowerCase() === staff.email,
    );
    if (exists) {
      result.existing.push(staff.role);
      continue;
    }

    const passwordHash = await bcrypt.hash(staff.password, 10);
    await User.create({ ...staff, passwordHash, isFirstLogin: true });
    result.created.push(staff.role);
  }

  return result;
};

module.exports = { restoreDemoStaff };
