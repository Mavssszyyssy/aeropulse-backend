const bcrypt = require("bcryptjs");
const connectDb = require("../config/db");
const User = require("../models/User");

const demoUsers = [
  {
    email: "admin-bulacan@example.com",
    alias: "admin.bulacan",
    password: "admin123",
    name: "Bulacan Admin",
    name_first: "Bulacan",
    name_last: "Admin",
    phone: "09123456783",
    address: "Bulacan Branch Office",
    role: "admin",
    assignedBranch: "Bulacan",
    activeBranch: "Bulacan",
  },
  {
    email: "admin-cavite@example.com",
    alias: "admin.cavite",
    password: "admin123",
    name: "Cavite Admin",
    name_first: "Cavite",
    name_last: "Admin",
    phone: "09123456784",
    address: "Cavite Branch Office",
    role: "admin",
    assignedBranch: "Cavite",
    activeBranch: "Cavite",
  },
  {
    email: "admin-laguna@example.com",
    alias: "admin.laguna",
    password: "admin123",
    name: "Laguna Admin",
    name_first: "Laguna",
    name_last: "Admin",
    phone: "09123456785",
    address: "Laguna Branch Office",
    role: "admin",
    assignedBranch: "Laguna",
    activeBranch: "Laguna",
  },
  {
    email: "admin-bataan@example.com",
    alias: "admin.bataan",
    password: "admin123",
    name: "Bataan Admin",
    name_first: "Bataan",
    name_last: "Admin",
    phone: "09123456786",
    address: "Bataan Branch Office",
    role: "admin",
    assignedBranch: "Bataan",
    activeBranch: "Bataan",
  },
  {
    email: "admin-pangasinan@example.com",
    alias: "admin.pangasinan",
    password: "admin123",
    name: "Pangasinan Admin",
    name_first: "Pangasinan",
    name_last: "Admin",
    phone: "09123456787",
    address: "Pangasinan Branch Office",
    role: "admin",
    assignedBranch: "Pangasinan",
    activeBranch: "Pangasinan",
  },
  {
    email: "admin-ilocos@example.com",
    alias: "admin.ilocos",
    password: "admin123",
    name: "Ilocos Admin",
    name_first: "Ilocos",
    name_last: "Admin",
    phone: "09123456788",
    address: "Ilocos Branch Office",
    role: "admin",
    assignedBranch: "Ilocos",
    activeBranch: "Ilocos",
  },
  {
    email: "tech@example.com",
    alias: "tech.main",
    password: "tech.123",
    name: "Technician User",
    name_first: "Technician",
    name_last: "User",
    phone: "09123456781",
    address: "Bulacan Branch Office",
    role: "technician",
    assignedBranch: "Bulacan",
    activeBranch: "Bulacan",
    technicianOnboardedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    email: "superadmin@example.com",
    alias: "superadmin.main",
    password: "admin123", // Using standard demo password
    name: "Super Admin",
    name_first: "Super",
    name_last: "Admin",
    phone: "09123456799",
    address: "Global Headquarters",
    role: "superadmin",
  },
];

const seedDemoUsers = async () => {
  for (const item of demoUsers) {
    // Seed identity is the stable account alias. Approved demo staff may have
    // their contact email changed without creating a replacement account.
    const exists = await User.findOne({
      $or: [{ alias: item.alias }, { username: item.alias }, { email: item.email }],
    });
    if (exists) {
      continue;
    }
    const configuredPassword = item.role === "superadmin"
      ? process.env.SEED_SUPERADMIN_PASSWORD
      : item.role === "technician"
        ? process.env.SEED_TECHNICIAN_PASSWORD || process.env.SEED_ADMIN_PASSWORD
        : process.env.SEED_ADMIN_PASSWORD;
    if (process.env.NODE_ENV === "production" && !configuredPassword) {
      throw new Error(`Set a private seed password before creating the ${item.role} account.`);
    }
    const passwordHash = await bcrypt.hash(configuredPassword || item.password, 10);
    const { password: _demoPassword, ...account } = item;
    await User.create({
      ...account,
      passwordHash,
      isFirstLogin: item.alias !== "tech.main",
    });
  }
  console.log("Demo users seeded.");
};

module.exports = { demoUsers, seedDemoUsers };

if (require.main === module) {
  connectDb()
    .then(() => seedDemoUsers())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
