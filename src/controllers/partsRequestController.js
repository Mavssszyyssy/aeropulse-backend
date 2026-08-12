const PartsRequest = require("../models/PartsRequest");
const Notification = require("../models/Notification");
const User = require("../models/User");

const REQUEST_STATUSES = ["Submitted", "Reviewed", "Assigned", "Completed", "Cancelled"];

const technicianName = (user = {}) =>
  user.name ||
  `${user.name_first || ""} ${user.name_last || ""}`.trim() ||
  user.email ||
  "Technician";

const createPartsRequest = async (req, res) => {
  if (req.authUser.role !== "technician") {
    return res.status(403).json({ message: "Only technicians can submit parts requests." });
  }

  const partName = String(req.body?.partName || "").trim();
  const reason = String(req.body?.reason || "").trim();
  const quantity = Number(req.body?.quantity);
  const priority = String(req.body?.priority || "Normal").trim();
  if (!partName || !reason || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: "Part name, a whole quantity of at least 1, and a reason are required." });
  }
  if (!["Normal", "Urgent"].includes(priority)) {
    return res.status(400).json({ message: "Priority must be Normal or Urgent." });
  }

  try {
    const request = await PartsRequest.create({
      requestedBy: req.authUser._id,
      technicianName: technicianName(req.authUser),
      branch: req.activeBranch || req.authUser.activeBranch || req.authUser.assignedBranch || "",
      taskId: String(req.body?.taskId || "").trim(),
      partName,
      quantity,
      reason,
      priority,
    });

    const reviewers = await User.find({ role: { $in: ["admin", "superadmin"] } }).select("_id role activeBranch assignedBranch");
    await Promise.all(
      reviewers
        .filter((reviewer) =>
          reviewer.role === "superadmin" ||
          !request.branch ||
          reviewer.activeBranch === request.branch ||
          reviewer.assignedBranch === request.branch,
        )
        .map((reviewer) =>
          Notification.create({
            user: reviewer._id,
            type: "system",
            title: "Technician parts request",
            message: `${request.technicianName} requested ${quantity} × ${partName}${priority === "Urgent" ? " (urgent)" : ""}.`,
          }),
        ),
    );

    return res.status(201).json({ request: request.toJSON() });
  } catch (error) {
    console.error("Failed to create parts request:", error);
    return res.status(500).json({ message: "Unable to submit the parts request right now." });
  }
};

const getMyPartsRequests = async (req, res) => {
  if (req.authUser.role !== "technician") {
    return res.status(403).json({ message: "Only technicians can view these parts requests." });
  }
  try {
    const requests = await PartsRequest.find({ requestedBy: req.authUser._id }).sort({ createdAt: -1 });
    return res.json({ requests: requests.map((request) => request.toJSON()) });
  } catch (error) {
    console.error("Failed to list technician parts requests:", error);
    return res.status(500).json({ message: "Unable to load parts requests right now." });
  }
};

const listPartsRequests = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Only administrators can review parts requests." });
  }
  try {
    const query = req.authUser.role === "superadmin" || !req.activeBranch ? {} : { branch: req.activeBranch };
    const requests = await PartsRequest.find(query).sort({ createdAt: -1 });
    return res.json({ requests: requests.map((request) => request.toJSON()) });
  } catch (error) {
    console.error("Failed to list parts requests:", error);
    return res.status(500).json({ message: "Unable to load parts requests right now." });
  }
};

const updatePartsRequestStatus = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Only administrators can update parts requests." });
  }
  const status = String(req.body?.status || "").trim();
  if (!REQUEST_STATUSES.includes(status)) {
    return res.status(400).json({ message: "Invalid parts request status." });
  }
  try {
    const request = await PartsRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ message: "Parts request not found." });
    if (req.authUser.role !== "superadmin" && request.branch && request.branch !== req.activeBranch) {
      return res.status(403).json({ message: "This request belongs to another branch." });
    }
    request.status = status;
    request.reviewedBy = req.authUser._id;
    request.reviewNote = String(req.body?.reviewNote || "").trim();
    await request.save();
    await Notification.create({
      user: request.requestedBy,
      type: "system",
      title: "Parts request updated",
      message: `Your request for ${request.quantity} × ${request.partName} is now ${status.toLowerCase()}.`,
    });
    return res.json({ request: request.toJSON() });
  } catch (error) {
    console.error("Failed to update parts request:", error);
    return res.status(500).json({ message: "Unable to update the parts request right now." });
  }
};

module.exports = {
  createPartsRequest,
  getMyPartsRequests,
  listPartsRequests,
  updatePartsRequestStatus,
};
