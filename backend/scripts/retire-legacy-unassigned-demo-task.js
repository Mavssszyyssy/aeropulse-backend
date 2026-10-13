/* eslint-disable no-console */
// Guarded, non-deleting cleanup for the one legacy dashboard seed that was
// historically created without a technician. The complete record is retained
// as cancelled history; no customer order or service request is touched.
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const connectDb = require("../src/config/db");
const Task = require("../src/models/Task");

const legacySeedIdentity = {
  taskCode: "TSK-002",
  title: "Refrigerator Maintenance",
  customer: "Jane Smith",
  address: "456 Oak Ave",
  branch: "Bulacan",
  scheduledDate: "2026-04-09",
  timeSlot: "1:00 PM - 4:00 PM",
  status: "pending",
  $and: [
    { $or: [{ assignedTechnicianId: { $exists: false } }, { assignedTechnicianId: "" }] },
    { $or: [{ orderId: { $exists: false } }, { orderId: "" }] },
    { $or: [{ requestId: { $exists: false } }, { requestId: "" }] },
    { $or: [{ "payload.orderId": { $exists: false } }, { "payload.orderId": "" }] },
    { $or: [{ "payload.orderCode": { $exists: false } }, { "payload.orderCode": "" }] },
    { $or: [{ "payload.requestId": { $exists: false } }, { "payload.requestId": "" }] },
    { $or: [{ "payload.activatedAt": { $exists: false } }, { "payload.activatedAt": "" }] },
    { $or: [{ "proof.submittedAt": { $exists: false } }, { "proof.submittedAt": null }] },
  ],
};

async function run() {
  await connectDb();
  const matches = await Task.collection.find(legacySeedIdentity).project({
    taskCode: 1,
    status: 1,
    branch: 1,
    assignedTechnicianId: 1,
  }).toArray();

  console.log(`Connected database: ${mongoose.connection.name}`);
  console.log(`Legacy unassigned demo task matches: ${matches.length}`);
  if (!process.argv.includes("--apply")) {
    console.log("Dry run only; no data changed.");
    console.log("Apply requires --apply plus the exact database name and confirmation phrase.");
    return;
  }

  if (process.env.CONFIRM_RETIRE_LEGACY_TASK !== "RETIRE_TSK_002") {
    throw new Error("Set CONFIRM_RETIRE_LEGACY_TASK=RETIRE_TSK_002 before applying this cleanup.");
  }
  const expectedDatabase = String(process.env.RETIRE_LEGACY_TASK_EXPECTED_DATABASE || "").trim();
  if (!expectedDatabase || mongoose.connection.name !== expectedDatabase) {
    throw new Error(
      `Set RETIRE_LEGACY_TASK_EXPECTED_DATABASE to the exact connected database name (${mongoose.connection.name}).`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one untouched TSK-002 legacy seed, found ${matches.length}; no data changed.`);
  }

  const result = await Task.collection.updateOne(legacySeedIdentity, {
    $set: {
      status: "cancelled",
      "payload.legacyCleanup": {
        reason: "Retired invalid unassigned dashboard demo seed during single-technician migration.",
        migratedAt: new Date(),
        migration: "single-technician-assignment-2026-10",
      },
      updatedAt: new Date(),
    },
  });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new Error("The guarded cleanup did not update exactly one record.");
  }
  console.log("Retired TSK-002 as preserved cancelled history. No record was deleted.");
}

run()
  .catch((error) => {
    console.error("Legacy task cleanup failed:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
