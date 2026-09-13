const { buildRecordedPartsPreparation } = require("../domain/partsPredictionService");
const Unit = require("../models/Unit");
const Task = require("../models/Task");
const ServiceRequest = require("../models/ServiceRequest");
const { resolveServiceVisitBranch } = require("../domain/serviceVisitBranch");

const getRecordedPartsPreparation = async (req, res) => {
  try {
    const unitId = req.query.unitId || req.query.unit_id;
    if (!unitId) {
      return res.status(400).json({ message: "unitId is required." });
    }

    const unit = await Unit.findById(unitId).select("serialNumber serviceBranch").lean();
    if (!unit) {
      return res.status(404).json({ message: "Installed AC unit not found." });
    }
    let assignedTask = null;
    if (req.authUser.role === "technician") {
      assignedTask = await Task.findOne({
        assignedTechnicianId: String(req.authUser._id || ""),
        $or: [
          { unitId: String(unitId) },
          { "payload.unitId": String(unitId) },
          { "payload.serialNumbers": unit.serialNumber },
          { "payload.items.serialNumbers": unit.serialNumber },
          { "payload.items.serialUnits.serialNumber": unit.serialNumber },
        ],
      }).sort({ updatedAt: -1 }).lean();
      if (!assignedTask) {
        return res.status(403).json({
          message: "This AC unit is not part of one of your assigned work orders.",
        });
      }
    }
    const requestId = String(assignedTask?.payload?.requestId || assignedTask?.requestId || "").trim();
    const serviceRequest = /^[a-f\d]{24}$/i.test(requestId)
      ? await ServiceRequest.findById(requestId).select("branch unitId").lean()
      : null;
    if (serviceRequest?.unitId && String(serviceRequest.unitId) !== String(unitId)) {
      return res.status(409).json({ message: "The service request is linked to a different AC unit. Ask an administrator to correct the booking." });
    }
    if (!["superadmin", "owner"].includes(req.authUser.role)) {
      const branchContext = resolveServiceVisitBranch({
        requestBranch: serviceRequest?.branch,
        taskBranch: assignedTask?.branch || assignedTask?.payload?.branch,
        unitBranch: unit.serviceBranch,
        technicianBranch: req.activeBranch,
      });
      if (branchContext.conflict) return res.status(409).json({ message: branchContext.conflict });
      if (branchContext.technicianMismatch) {
        return res.status(403).json({ message: "This AC unit belongs to another branch." });
      }
    }

    const result = await buildRecordedPartsPreparation({ unitId });
    return res.json(result);
  } catch (error) {
    console.error("Failed to load recorded parts preparation:", error);
    return res.status(error.status || 500).json({
      message: error.message || "Unable to load recorded parts preparation.",
    });
  }
};

module.exports = { getRecordedPartsPreparation };
