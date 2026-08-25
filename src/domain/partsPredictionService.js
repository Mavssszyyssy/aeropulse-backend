const ServiceHistory = require("../models/ServiceHistory");
const Unit = require("../models/Unit");

const predictLikelyFailingParts = async ({ unitId }) => {
  const unit = await Unit.findById(unitId).lean();
  if (!unit) { const error = new Error("Unit not found"); error.status = 404; throw error; }
  const comparableUnits = await Unit.find({
    _id: { $ne: unit._id },
    brand: { $regex: new RegExp(`^${String(unit.brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    status: { $ne: "retired" },
  }).select("_id modelName").limit(500).lean();
  const ids = [unit._id, ...comparableUnits.map((item) => item._id)];
  const histories = await ServiceHistory.find({ unit: { $in: ids }, partsUsed: { $exists: true, $ne: [] } }).select("unit partsUsed serviceDate").sort({ serviceDate: -1 }).limit(2000).lean();
  const counts = new Map();
  histories.forEach((history) => (history.partsUsed || []).forEach((part) => {
    const component = String(part || "").trim(); if (component) counts.set(component, (counts.get(component) || 0) + 1);
  }));
  const parts = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, recordedCount]) => ({
    name, recordedCount,
    reason: `This component appears in ${recordedCount} recorded service record${recordedCount === 1 ? "" : "s"} for this unit or comparable units. Bring only for inspection readiness; this is not a failure diagnosis.`,
  }));
  return {
    unitId: String(unit._id), serialNumber: unit.serialNumber, generatedAt: new Date().toISOString(), parts,
    label: "Technician preparation suggestions",
    note: "Suggestions are based only on recorded component history and do not confirm a fault.",
  };
};

module.exports = { predictLikelyFailingParts };
