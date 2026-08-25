const { predictLikelyFailingParts } = require("../domain/partsPredictionService");
const Unit = require("../models/Unit");
const Task = require("../models/Task");

const getPredictedParts = async (req, res) => {
  try {
    const unitId = req.query.unitId || req.query.unit_id;
    if (!unitId) {
      return res.status(400).json({ message: "unitId is required." });
    }

    const unit = await Unit.findById(unitId).select("serialNumber serviceBranch").lean();
    if (!unit) {
      return res.status(404).json({ message: "Installed AC unit not found." });
    }
    if (
      !["superadmin", "owner"].includes(req.authUser.role) &&
      req.activeBranch &&
      unit.serviceBranch &&
      unit.serviceBranch !== req.activeBranch
    ) {
      return res.status(403).json({ message: "This AC unit belongs to another branch." });
    }
    if (req.authUser.role === "technician") {
      const isAssigned = await Task.exists({
        assignedTechnicianId: String(req.authUser._id || ""),
        $or: [
          { unitId: String(unitId) },
          { "payload.unitId": String(unitId) },
          { "payload.serialNumbers": unit.serialNumber },
          { "payload.items.serialNumbers": unit.serialNumber },
          { "payload.items.serialUnits.serialNumber": unit.serialNumber },
        ],
      });
      if (!isAssigned) {
        return res.status(403).json({
          message: "This AC unit is not part of one of your assigned work orders.",
        });
      }
    }

    const result = await predictLikelyFailingParts({ unitId });
    return res.json(result);
  } catch (error) {
    console.error("Failed to predict likely failing parts:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to load predicted parts.",
    });
  }
};

module.exports = { getPredictedParts };
