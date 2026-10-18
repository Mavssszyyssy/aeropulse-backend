const mongoose = require("mongoose");
const { reconcileCancelledWarranty } = require('../domain/warrantyCancellation');
const Unit = require("../models/Unit");
const Task = require("../models/Task");
const ServiceRequest = require("../models/ServiceRequest");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { notifyOperationalStaff } = require("../services/operationalNotificationService");
const { appendWarrantyEvent, effectiveWarrantyStatus, getWarrantyRecommendation, getWarrantyCoverage, warrantyApprovalError } = require("../domain/warrantyService");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const { assertAmpBranch } = require("../domain/ampAccess");

const displayName = (user = {}) =>
  user.name || `${user.name_first || ""} ${user.name_last || ""}`.trim() || user.email || user.role || "System";

const resolveUnitBranch = async (unit) =>
  String(unit?.serviceBranch || "").trim() ||
  resolvePreferredBranch({
    city: unit?.installation?.city,
    province: unit?.installation?.province,
  });

const getUnitForRequest = async (req) => {
  assertAmpBranch(req);
  const unit = await Unit.findById(req.params.unitId);
  if (!unit) return null;
  const role = req.authUser.role;
  if (role === "customer" && String(unit.customer || "") !== String(req.authUser._id || "")) return null;
  if (role === "admin") {
    const branch = await resolveUnitBranch(unit);
    if (branch && branch !== String(req.activeBranch || "")) return null;
  }
  if (role === "technician") {
    const serialNumber = String(unit.serialNumber || "").trim();
    const task = await Task.exists({
      assignedTechnicianId: String(req.authUser._id || ""),
      $or: [
        { unitId: String(unit._id) },
        { "payload.unitId": String(unit._id) },
        { "payload.serialNumbers": serialNumber },
        { "payload.items.serialNumbers": serialNumber },
        { "payload.items.serialUnits.serialNumber": serialNumber },
      ],
    });
    if (!task) return null;
  }
  return reconcileCancelledWarranty(unit);
};

const warrantySnapshot = (unit) => {
  const warranty = unit?.warranty?.toObject?.() || unit?.warranty || {};
  return {
    ...warranty,
    ...getWarrantyCoverage(warranty),
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
    return res.json({
      unitId: String(unit._id),
      serialNumber: unit.serialNumber,
      warranty,
      recommendation: getWarrantyRecommendation(warranty),
    });
  } catch (error) {
    console.error("Failed to load warranty:", error);
    return res.status(500).json({ message: "Unable to load warranty details." });
  }
};

const listWarrantyClaims = async (req, res) => {
  try {
    assertAmpBranch(req);
    if (!["admin", "superadmin"].includes(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const units = await Unit.find({ "warranty.claims.0": { $exists: true } })
      .select("serialNumber brand modelName customerName serviceBranch installation warranty")
      .sort({ updatedAt: -1 });
    const claimGroups = await Promise.all(units.map(async (unit) => {
      const warranty = warrantySnapshot(unit);
      const branch = await resolveUnitBranch(unit);
      return warranty.claims.map((claim) => ({
        ...claim,
        unitId: String(unit._id),
        serialNumber: unit.serialNumber,
        unitName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || "Installed AC Unit",
        customerName: unit.customerName || "Customer",
        branch,
        warrantyStatus: warranty.status,
        ...getWarrantyCoverage(warranty),
      }));
    }));
    const claims = claimGroups
      .flat()
      .filter((claim) => req.authUser.role === "superadmin" || claim.branch === req.activeBranch)
      .sort((left, right) => new Date(right.requestedAt || 0) - new Date(left.requestedAt || 0));
    return res.json({ claims });
  } catch (error) {
    console.error("Failed to list warranty claims:", error);
    return res.status(error.status || 500).json({ message: error.status === 403 ? error.message : "Unable to load warranty claims." });
  }
};

const createWarrantyClaim = async (req, res) => {
  try {
    const unit = await getUnitForRequest(req);
    if (!unit) return res.status(404).json({ message: "AC unit not found." });
    const issue = String(req.body?.issue || req.body?.description || "").trim();
    if (!issue) return res.status(400).json({ message: "Describe the warranty issue before submitting a claim." });

    const warranty = warrantySnapshot(unit);
    if (warranty.status !== "active") {
      const message = warranty.status === "pending_activation"
        ? "Warranty support becomes available after the technician completes and verifies the installation."
        : `This warranty is ${warranty.status} and cannot accept a new claim.`;
      return res.status(409).json({ message });
    }
    const activeClaim = warranty.claims.find((claim) =>
      ["submitted", "under_review", "approved"].includes(String(claim?.status || "")),
    );
    if (activeClaim) {
      return res.status(200).json({
        message: "This unit already has an active warranty claim.",
        claim: activeClaim,
        warranty,
        replayed: true,
      });
    }

    const activeServiceRequest = await ServiceRequest.findOne({
      createdBy: req.authUser._id,
      unitId: String(unit._id),
      status: { $in: ["Pending", "Submitted", "Reviewed", "Assigned", "In Progress", "On Hold"] },
    }).sort({ createdAt: -1 });
    if (activeServiceRequest) {
      return res.status(409).json({
        message: "This AC unit already has an active service request. Complete or cancel it before starting a warranty claim.",
        request: activeServiceRequest,
      });
    }

    const claim = {
      claimId: `WCL-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      issue,
      status: "submitted",
      requestedAt: new Date(),
      decisionNote: String(req.body?.notes || "").trim(),
    };
    warranty.claims = [...warranty.claims, claim];
    warranty.status = effectiveWarrantyStatus(warranty);
    warranty.timeline = appendWarrantyEvent(warranty, "Warranty Claim Submitted", issue);
    unit.warranty = warranty;
    await unit.save();
    await notifyOperationalStaff({
      branch: await resolveUnitBranch(unit),
      title: "New warranty claim",
      message: `${unit.customerName || "A customer"} submitted claim ${claim.claimId} for ${unit.modelName || unit.serialNumber}.`,
      type: "warranty",
      category: "warranty_claim",
      severity: "warning",
      targetId: String(unit._id),
      targetType: "warranty",
      dedupeKey: `warranty-claim:${claim.claimId}`,
    });
    const savedWarranty = warrantySnapshot(unit);
    return res.status(201).json({
      claim,
      warranty: savedWarranty,
      recommendation: getWarrantyRecommendation(savedWarranty),
    });
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
    const unitBranch = await resolveUnitBranch(unit);
    if (req.authUser.role === "admin" && unitBranch && unitBranch !== req.activeBranch) {
      return res.status(403).json({ message: "This warranty claim belongs to another branch." });
    }
    const warranty = warrantySnapshot(unit);
    const index = warranty.claims.findIndex((claim) => String(claim?.claimId || "") === String(req.params.claimId || ""));
    if (index < 0) return res.status(404).json({ message: "Warranty claim not found." });
    const status = String(req.body?.status || "").toLowerCase();
    if (!["under_review", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Use under_review, approved, or rejected for a warranty claim." });
    }

    const claim = { ...warranty.claims[index] };
    const previousStatus = String(claim.status || "submitted").toLowerCase();
    if (previousStatus === 'cancelled') return res.status(409).json({ message: 'This warranty service was cancelled. Submit a new claim for further support.' });
    const nextDecisionNote = String(req.body?.decisionNote || req.body?.notes || claim.decisionNote || "").trim();
    const coveredComponent = String(req.body?.coveredComponent || claim.coveredComponent || "").toLowerCase();
    if (status === "approved" && !claim.serviceRequestId) {
      const coverageError = warranty.status !== "active" ? "This unit does not have active warranty coverage." : warrantyApprovalError(warranty, coveredComponent);
      if (coverageError) return res.status(409).json({ message: coverageError });
    }
    if (previousStatus === "service_completed") {
      return res.status(409).json({ message: "A completed warranty service cannot be reopened or changed." });
    }
    if (claim.serviceRequestId && previousStatus === "approved" && status !== "approved") {
      return res.status(409).json({
        message: "This approved claim already has a service job. Complete or cancel that job through the service workflow instead of reversing the claim.",
      });
    }
    if (previousStatus === status && nextDecisionNote === String(claim.decisionNote || "").trim()) {
      return res.json({
        claim,
        warranty,
        recommendation: getWarrantyRecommendation(warranty),
        replayed: true,
      });
    }
    claim.status = status;
    claim.reviewedAt = new Date();
    claim.reviewerName = displayName(req.authUser);
    claim.decisionNote = nextDecisionNote;
    if (status === "approved") claim.coveredComponent = coveredComponent;

    if (status === "approved" && !claim.serviceRequestId) {
      const address = [unit.installation?.addressLine, unit.installation?.city, unit.installation?.province].filter(Boolean).join(", ") || "Installation address";
      const existingWarrantyRequest = await ServiceRequest.findOne({
        createdBy: unit.customer,
        unitId: String(unit._id),
        "payload.warrantyClaimId": claim.claimId,
      });
      const conflictingRequest = existingWarrantyRequest ? null : await ServiceRequest.findOne({
        createdBy: unit.customer,
        unitId: String(unit._id),
        status: { $in: ["Pending", "Submitted", "Reviewed", "Assigned", "In Progress", "On Hold"] },
      }).sort({ createdAt: -1 });
      if (conflictingRequest) {
        return res.status(409).json({
          message: "This AC unit already has an active service request. Complete or cancel it before approving the warranty claim.",
        });
      }

      const customer = unit.customer ? await User.findById(unit.customer).select("email phone") : null;
      const request = existingWarrantyRequest || await ServiceRequest.create({
          customer: unit.customerName || displayName(customer || {}) || "Customer",
          issue: `Warranty claim ${claim.claimId}: ${claim.issue}`,
          address,
          branch: unitBranch,
          status: "Reviewed",
          customerId: String(unit.customer || ""),
          customerEmail: String(customer?.email || ""),
          customerPhone: String(customer?.phone || ""),
          unitId: String(unit._id),
          unitName: unit.modelName || "Installed AC Unit",
          issueType: "Warranty Repair",
          payload: {
            warrantyClaimId: claim.claimId,
            warrantyRelated: true,
            coveredComponent,
            unitSerialNumber: unit.serialNumber,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          createdBy: unit.customer,
          idempotencyKey: `warranty-claim:${claim.claimId}`,
        });
      claim.serviceRequestId = String(request._id || request.id || "");
    }

    warranty.claims[index] = claim;
    // Claim decisions never replace the unit's coverage status. The claim
    // keeps its own workflow state while the warranty remains active, expired,
    // pending activation, or void according to the actual coverage record.
    warranty.status = effectiveWarrantyStatus(warranty);
    warranty.timeline = appendWarrantyEvent(
      warranty,
      status === "approved" ? "Warranty Claim Approved" : status === "rejected" ? "Warranty Claim Rejected" : "Warranty Claim Under Review",
      claim.decisionNote || claim.issue,
    );
    unit.warranty = warranty;
    await unit.save();

    if (unit.customer && mongoose.Types.ObjectId.isValid(String(unit.customer))) {
      await Notification.findOneAndUpdate(
        {
          user: unit.customer,
          type: "warranty",
          targetType: "warranty",
          targetId: String(unit._id),
          dedupeKey: `warranty-claim:${unit._id}:${claim.claimId}:${status}`,
        },
        {
          user: unit.customer,
          type: "warranty",
          title: `Warranty claim ${status.replace("_", " ")}`,
          message: `Your warranty claim for ${unit.modelName || unit.serialNumber} is ${status.replace("_", " ")}.`,
          route: `/customer/units/${unit._id}`,
          targetId: String(unit._id),
          targetType: "warranty",
          category: "warranty_claim",
          dedupeKey: `warranty-claim:${unit._id}:${claim.claimId}:${status}`,
          unread: true,
          status: "unread",
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    }
    await notifyOperationalStaff({
      branch: unitBranch,
      title: `Warranty claim ${status.replace("_", " ")}`,
      message: `Claim ${claim.claimId} for ${unit.modelName || unit.serialNumber} is ${status.replace("_", " ")}.`,
      type: "warranty",
      category: "warranty_claim",
      severity: status === "rejected" ? "warning" : "info",
      targetId: String(unit._id),
      targetType: "warranty",
      dedupeKey: `warranty-claim:${claim.claimId}:${status}`,
    });
    const savedWarranty = warrantySnapshot(unit);
    return res.json({
      claim,
      warranty: savedWarranty,
      recommendation: getWarrantyRecommendation(savedWarranty),
    });
  } catch (error) {
    console.error("Failed to review warranty claim:", error);
    return res.status(500).json({ message: "Unable to update warranty claim." });
  }
};

module.exports = { listWarranty, listWarrantyClaims, createWarrantyClaim, reviewWarrantyClaim };
