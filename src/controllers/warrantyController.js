const mongoose = require("mongoose");
const Unit = require("../models/Unit");
const ServiceRequest = require("../models/ServiceRequest");
const Notification = require("../models/Notification");
const { notifyOperationalStaff } = require("../services/operationalNotificationService");
const { appendWarrantyEvent, effectiveWarrantyStatus } = require("../domain/warrantyService");
const { resolvePreferredBranch } = require("../domain/branchRouting");

const displayName = (user = {}) =>
  user.name || `${user.name_first || ""} ${user.name_last || ""}`.trim() || user.email || user.role || "System";

const getUnitForRequest = async (req) => {
  const unit = await Unit.findById(req.params.unitId);
  if (!unit) return null;
  if (req.authUser.role === "customer" && String(unit.customer || "") !== String(req.authUser._id || "")) return null;
  return unit;
};

const warrantySnapshot = (unit) => {
  const warranty = unit?.warranty?.toObject?.() || unit?.warranty || {};
  return {
    ...warranty,
    status: effectiveWarrantyStatus(warranty),
    claims: Array.isArray(warranty.claims) ? warranty.claims : [],
    serviceRecords: Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : [],
    timeline: Array.isArray(warranty.timeline) ? warranty.timeline : [],
  };
};

const listWarranty = async (req, res) => {
  try {
    const unit = await getUnitForRequest(req);
    if (!unit) return res.status(404).json({ message: "AC unit not found." });
    const warranty = warrantySnapshot(unit);
    if (unit.warranty) {
      unit.warranty.status = warranty.status;
      await unit.save();
    }
    return res.json({ unitId: String(unit._id), serialNumber: unit.serialNumber, warranty });
  } catch (error) {
    console.error("Failed to load warranty:", error);
    return res.status(500).json({ message: "Unable to load warranty details." });
  }
};

const listWarrantyClaims = async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const units = await Unit.find({ "warranty.claims.0": { $exists: true } })
      .select("serialNumber brand modelName customerName installation warranty")
      .sort({ updatedAt: -1 });
    const claims = units.flatMap((unit) => {
      const warranty = warrantySnapshot(unit);
      return warranty.claims.map((claim) => ({
        ...claim,
        unitId: String(unit._id),
        serialNumber: unit.serialNumber,
        unitName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
        customerName: unit.customerName || "Customer",
        branch: resolvePreferredBranch({
          city: unit.installation?.city,
          province: unit.installation?.province,
        }),
        warrantyStatus: warranty.status,
      }));
    }).sort((left, right) => new Date(right.requestedAt || 0) - new Date(left.requestedAt || 0));
    return res.json({ claims });
  } catch (error) {
    console.error("Failed to list warranty claims:", error);
    return res.status(500).json({ message: "Unable to load warranty claims." });
  }
};

const createWarrantyClaim = async (req, res) => {
  try {
    const unit = await getUnitForRequest(req);
    if (!unit) return res.status(404).json({ message: "AC unit not found." });
    const issue = String(req.body?.issue || req.body?.description || "").trim();
    if (!issue) return res.status(400).json({ message: "Describe the warranty issue before submitting a claim." });

    const warranty = warrantySnapshot(unit);
    if (warranty.status === "expired" || warranty.status === "void") {
      return res.status(409).json({ message: `This warranty is ${warranty.status} and cannot accept a new claim.` });
    }
    const activeClaim = warranty.claims.find((claim) =>
      ["submitted", "under_review", "approved"].includes(String(claim?.status || "")),
    );
    if (activeClaim) {
      return res.status(409).json({ message: "This unit already has an active warranty claim.", claim: activeClaim });
    }

    const claim = {
      claimId: `WCL-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      issue,
      status: "submitted",
      requestedAt: new Date(),
      decisionNote: String(req.body?.notes || "").trim(),
    };
    warranty.claims = [...warranty.claims, claim];
    warranty.status = "under_review";
    warranty.timeline = appendWarrantyEvent(warranty, "Warranty Claim Submitted", issue);
    unit.warranty = warranty;
    await unit.save();
    await notifyOperationalStaff({
      branch: resolvePreferredBranch({ city: unit.installation?.city, province: unit.installation?.province }),
      title: "New warranty claim",
      message: `${unit.customerName || "A customer"} submitted claim ${claim.claimId} for ${unit.modelName || unit.serialNumber}.`,
      type: "warranty",
      category: "warranty_claim",
      severity: "warning",
      targetId: String(unit._id),
      targetType: "warranty",
      dedupeKey: `warranty-claim:${claim.claimId}`,
    });
    return res.status(201).json({ claim, warranty: warrantySnapshot(unit) });
  } catch (error) {
    console.error("Failed to create warranty claim:", error);
    return res.status(500).json({ message: "Unable to submit warranty claim." });
  }
};

const reviewWarrantyClaim = async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.authUser.role)) return res.status(403).json({ message: "Forbidden" });
    const unit = await Unit.findById(req.params.unitId);
    if (!unit) return res.status(404).json({ message: "AC unit not found." });
    const warranty = warrantySnapshot(unit);
    const index = warranty.claims.findIndex((claim) => String(claim?.claimId || "") === String(req.params.claimId || ""));
    if (index < 0) return res.status(404).json({ message: "Warranty claim not found." });
    const status = String(req.body?.status || "").toLowerCase();
    if (!["under_review", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Use under_review, approved, or rejected for a warranty claim." });
    }

    const claim = { ...warranty.claims[index] };
    claim.status = status;
    claim.reviewedAt = new Date();
    claim.reviewerName = displayName(req.authUser);
    claim.decisionNote = String(req.body?.decisionNote || req.body?.notes || claim.decisionNote || "").trim();

    if (status === "approved" && !claim.serviceRequestId) {
      const address = [unit.installation?.addressLine, unit.installation?.city, unit.installation?.province].filter(Boolean).join(", ") || "Installation address";
      const request = await ServiceRequest.create({
        customer: unit.customerName || "Customer",
        issue: `Warranty claim ${claim.claimId}: ${claim.issue}`,
        address,
        branch: resolvePreferredBranch({
          city: unit.installation?.city,
          province: unit.installation?.province,
        }),
        status: "Reviewed",
        customerId: String(unit.customer || ""),
        unitId: String(unit._id),
        unitName: unit.modelName || "Installed AC Unit",
        issueType: "Warranty Repair",
        payload: {
          warrantyClaimId: claim.claimId,
          warrantyRelated: true,
          unitSerialNumber: unit.serialNumber,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        createdBy: unit.customer,
      });
      claim.serviceRequestId = String(request._id || request.id || "");
    }

    warranty.claims[index] = claim;
    warranty.status = status === "rejected" ? "rejected" : status;
    warranty.timeline = appendWarrantyEvent(
      warranty,
      status === "approved" ? "Warranty Claim Approved" : status === "rejected" ? "Warranty Claim Rejected" : "Warranty Claim Under Review",
      claim.decisionNote || claim.issue,
    );
    unit.warranty = warranty;
    await unit.save();

    if (unit.customer && mongoose.Types.ObjectId.isValid(String(unit.customer))) {
      await Notification.create({
        user: unit.customer,
        type: "system",
        title: `Warranty claim ${status.replace("_", " ")}`,
        message: `Your warranty claim for ${unit.modelName || unit.serialNumber} is ${status.replace("_", " ")}.`,
        route: "/customer/units",
        targetId: String(unit._id),
      });
    }
    await notifyOperationalStaff({
      branch: resolvePreferredBranch({ city: unit.installation?.city, province: unit.installation?.province }),
      title: `Warranty claim ${status.replace("_", " ")}`,
      message: `Claim ${claim.claimId} for ${unit.modelName || unit.serialNumber} is ${status.replace("_", " ")}.`,
      type: "warranty",
      category: "warranty_claim",
      severity: status === "rejected" ? "warning" : "info",
      targetId: String(unit._id),
      targetType: "warranty",
      dedupeKey: `warranty-claim:${claim.claimId}:${status}`,
    });
    return res.json({ claim, warranty: warrantySnapshot(unit) });
  } catch (error) {
    console.error("Failed to review warranty claim:", error);
    return res.status(500).json({ message: "Unable to update warranty claim." });
  }
};

module.exports = { listWarranty, listWarrantyClaims, createWarrantyClaim, reviewWarrantyClaim };
