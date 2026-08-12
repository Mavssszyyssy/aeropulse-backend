const bcrypt = require("bcryptjs");
const connectDb = require("../config/db");
const User = require("../models/User");
const Order = require("../models/Order");

const users = [
  {
    email: "demo@example.com",
    alias: "demo.user",
    password: "demo123",
    name: "Demo User",
    name_first: "Demo",
    name_last: "User",
    phone: "09123456789",
    address: "123 Demo Street, Molino I, Bacoor, Cavite, CALABARZON",
    billingAddress: {
      region: "CALABARZON",
      province: "Cavite",
      city: "Bacoor",
      barangay: "Molino I",
      street: "123 Demo Street",
    },
    addresses: [
      {
        label: "Billing Address",
        type: "home",
        name: "Demo User",
        phone: "09123456789",
        region: "CALABARZON",
        province: "Cavite",
        city: "Bacoor",
        barangay: "Molino I",
        street: "123 Demo Street",
        postalCode: "4102",
        isDefault: true,
      },
    ],
    role: "customer",
  },
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
    email: "tech@example.com",
    alias: "tech.main",
    password: "tech123",
    name: "Technician User",
    name_first: "Tech",
    name_last: "User",
    phone: "09123456781",
    address: "789 Tech Street",
    role: "technician",
    assignedBranch: "Bulacan",
    activeBranch: "Bulacan",
    skills: ["Electronics Repair", "AC Repair", "Plumbing"],
  },
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
  for (const item of users) {
    const exists = await User.findOne({ email: item.email });
    if (exists) {
      continue;
    }
    const passwordHash = await bcrypt.hash(item.password, 10);
    await User.create({ ...item, passwordHash });
  }
  console.log("Demo users seeded.");
};

module.exports = { seedDemoUsers };

if (require.main === module) {
  connectDb()
    .then(() => seedDemoUsers())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
