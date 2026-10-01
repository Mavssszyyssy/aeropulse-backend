const mongoose = require("mongoose");
const connectDb = require("../src/config/db");
const AuditLog = require("../src/models/AuditLog");
const ContactMessage = require("../src/models/ContactMessage");
const InventoryChangeRequest = require("../src/models/InventoryChangeRequest");
const PartsRequest = require("../src/models/PartsRequest");
const ReorderRequest = require("../src/models/ReorderRequest");
const RestockOrder = require("../src/models/RestockOrder");
const User = require("../src/models/User");

const performanceIndexModels = [
  AuditLog,
  ContactMessage,
  InventoryChangeRequest,
  PartsRequest,
  ReorderRequest,
  RestockOrder,
  User,
];

const plannedIndexes = () => performanceIndexModels.map((model) => ({
  collection: model.collection.name,
  indexes: model.schema.indexes().map(([keys, options]) => ({ keys, options })),
}));

const ensurePerformanceIndexes = async () => {
  await connectDb();
  const results = [];
  for (const model of performanceIndexModels) {
    await model.createIndexes();
    results.push({
      collection: model.collection.name,
      indexes: await model.collection.indexes(),
    });
  }
  return results;
};

const main = async () => {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log(JSON.stringify({
      mode: "dry-run",
      message: "No database changes were made. Add --apply to create missing declared indexes without dropping existing indexes.",
      collections: plannedIndexes(),
    }, null, 2));
    return;
  }

  try {
    const results = await ensurePerformanceIndexes();
    console.log(JSON.stringify({
      mode: "applied",
      message: "Declared indexes are present. No indexes were dropped.",
      collections: results.map(({ collection, indexes }) => ({
        collection,
        indexNames: indexes.map((index) => index.name),
      })),
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Unable to create performance indexes:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { ensurePerformanceIndexes, performanceIndexModels, plannedIndexes };
