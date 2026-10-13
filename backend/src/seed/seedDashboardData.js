const Task = require("../models/Task");
const Order = require("../models/Order");

const taskSeeds = [
  {
    taskCode: "TSK-001",
    title: "AC Repair - Unit #123",
    customer: "Demo User",
    address: "123 Demo Street, Molino I, Bacoor, Cavite, CALABARZON",
    status: "in-progress",
    priority: "high",
    scheduledDate: "2026-04-09",
    timeSlot: "9:00 AM - 12:00 PM",
    assignedTechnicianId: "tech@example.com", // Will be updated to actual ID
    assignedTechnicianName: "Technician User",
    branch: "Bulacan",
    unitId: "DEMO-UNIT-001",
    unitName: "Demo AC Unit",
  },
  {
    taskCode: "TSK-002",
    title: "Refrigerator Maintenance",
    customer: "Jane Smith",
    address: "456 Oak Ave",
    status: "pending",
    priority: "medium",
    scheduledDate: "2026-04-09",
    timeSlot: "1:00 PM - 4:00 PM",
    assignedTechnicianId: "tech@example.com", // Will be updated to actual ID
    assignedTechnicianName: "Technician User",
    branch: "Bulacan",
  },
  {
    taskCode: "TSK-003",
    title: "Washing Machine Repair",
    customer: "Mike Johnson",
    address: "789 Pine Rd",
    status: "completed",
    priority: "low",
    scheduledDate: "2026-04-08",
    timeSlot: "9:00 AM - 12:00 PM",
    completedAt: new Date(),
    assignedTechnicianId: "tech@example.com", // Will be updated to actual ID
    assignedTechnicianName: "Technician User",
    branch: "Bulacan",
  },
];

const orderSeeds = [
  { orderCode: "ORD-001", customerName: "John Doe", totalAmount: 5200, status: "paid" },
  { orderCode: "ORD-002", customerName: "Jane Smith", totalAmount: 7600, status: "paid" },
  { orderCode: "ORD-003", customerName: "Mike Johnson", totalAmount: 2950, status: "pending" },
];

const assignTechnicianToTaskSeeds = (technician) => {
  const technicianId = String(technician?._id || "").trim();
  if (!technicianId) {
    throw new Error("Dashboard task seed requires the canonical demo technician.");
  }
  const technicianName = String(technician?.name || "Technician User").trim();
  return taskSeeds.map((task) => ({
    ...task,
    assignedTechnicianId: technicianId,
    assignedTechnicianName: technicianName,
  }));
};

const seedDashboardData = async () => {
  // Get technician user for assignment
  const technician = await require("../models/User").findOne({ email: "tech@example.com" });
  const updatedTaskSeeds = assignTechnicianToTaskSeeds(technician);

  for (const seed of updatedTaskSeeds) {
    const exists = await Task.findOne({ taskCode: seed.taskCode });
    if (!exists) {
      await Task.create(seed);
    }
  }

  for (const seed of orderSeeds) {
    const exists = await Order.findOne({ orderCode: seed.orderCode });
    if (!exists) {
      await Order.create(seed);
    }
  }
};

module.exports = { seedDashboardData, assignTechnicianToTaskSeeds };
