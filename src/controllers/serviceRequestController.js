const mongoose = require("mongoose");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const Unit = require("../models/Unit");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { notifyOperationalStaff } = require("../services/operationalNotificationService");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const { getServiceCatalog, findServiceOffering } = require("../domain/serviceCatalog");
const env = require("../config/env");

const normalizeStatus = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "Pending";
  if (normalized === "in progress") return "In Progress";
  if (normalized === "submitted") return "Submitted";
  if (normalized === "reviewed") return "Reviewed";
  if (normalized === "assigned") return "Assigned";
  if (normalized === "completed") return "Completed";
  if (normalized === "cancelled") return "Cancelled";
  return normalized.replace(/^\w/, (c) => c.toUpperCase());
};

const ACTIVE_REQUEST_STATUSES = ["Submitted", "Reviewed", "Assigned", "In Progress", "Pending"];

const hydrateRequestResponse = (request) => {
  const json = request.toJSON ? request.toJSON() : request;
  const payload = request.payload && Object.keys(request.payload).length ? request.payload : null;
  if (!payload) return json;
  return {
    ...payload,
    ...json,
    userId: payload.userId || json.customerId || String(json.createdBy || ""),
    customerName: payload.customerName || json.customer,
    issueDescription: payload.issueDescription || payload.concern || json.issue,
    concern: payload.concern || payload.issueDescription || json.issue,
    serviceType: payload.serviceType || json.issueType,
    serviceId: payload.serviceId || "",
    pricing: payload.pricing || null,
    issueType: payload.issueType || json.issueType,
    linkedTaskId: payload.linkedTaskId || "",
    unitSerialNumber: payload.unitSerialNumber || payload.serialNumber || "",
    qrCode: payload.qrCode || "",
    status: payload.status || json.status,
    createdAt: payload.createdAt || json.createdAt,
    updatedAt: payload.updatedAt || json.updatedAt,
  };
};

const getTechnicianDisplayName = (technician = {}) =>
  technician.name ||
  `${technician.name_first || ""} ${technician.name_last || ""}`.trim() ||
  technician.email ||
  "Technician";

const getUserDisplayName = (user = {}) =>
  user.name ||
  `${user.name_first || ""} ${user.name_last || ""}`.trim() ||
  user.email ||
  "Customer";

const getRequestBranch = async ({ req, payload = {}, unit = null }) => {
  if (req.authUser.role === "admin" || req.authUser.role === "manager" || req.authUser.role === "technician") {
    return req.activeBranch || String(payload.branch || "");
  }
  if (req.authUser.role === "superadmin") return String(payload.branch || "");

  const unitAddress = unit?.installation || {};
  // Customer addresses are the source of truth. Do not trust a stale branch
  // value from a mobile/web payload after the customer changes location.
  return resolvePreferredBranch({
    city: payload.city || unitAddress.city || "",
    province: payload.province || unitAddress.province || "",
    barangay: payload.barangay || unitAddress.barangay || "",
    street: payload.address || unitAddress.addressLine || "",
  });
};

const notifyUser = async ({ userId, title, message }) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  try {
    return await Notification.create({
      user: userId,
      type: "system",
      title,
      message,
    });
  } catch (error) {
    console.error("Failed to create service request notification:", error);
    return null;
  }
};

const findOwnedUnit = async (unitId, userId) => {
  if (!unitId || !mongoose.Types.ObjectId.isValid(String(unitId))) return null;
  return Unit.findOne({ _id: unitId, customer: userId });
};

const buildTimelineEvent = ({ title, description, actor }) => ({
  id: `service_timeline_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
  title,
  description,
  actor,
  timestamp: new Date().toISOString(),
});

const upsertServiceTaskForRequest = async (request, payload = {}) => {
  const technicianId = String(
    payload.assignedTechnicianId || request.assignedTechnicianId || "",
  ).trim();
  if (!technicianId) return null;

  const technician = mongoose.Types.ObjectId.isValid(technicianId)
    ? await User.findById(technicianId).select("name name_first name_last email")
    : null;
  const technicianName = String(
    payload.assignedTechnicianName || request.assignedTechnicianName || getTechnicianDisplayName(technician),
  ).trim();
  const existingTaskId = String(request.payload?.linkedTaskId || payload.linkedTaskId || "").trim();
  const nowIso = new Date().toISOString();
  const commonPayload = {
    ...(request.payload || {}),
    requestId: String(request._id || request.id || ""),
    source: "service_request",
    customerName: request.customer,
    customerId: request.customerId,
    serviceType: request.payload?.serviceType || request.issueType || "Service Request",
    issueDescription: request.issue,
    unitSerialNumber: request.payload?.unitSerialNumber || "",
    qrCode: request.payload?.qrCode || "",
    status: "pending",
    updatedAt: nowIso,
  };

  let task = null;
  if (existingTaskId) {
    const conditions = [];
    if (mongoose.Types.ObjectId.isValid(existingTaskId)) conditions.push({ _id: existingTaskId });
    conditions.push({ taskCode: existingTaskId });
    task = await Task.findOne({ $or: conditions });
  }

  if (!task) {
    task = new Task({
      taskCode: `TSK-${Date.now()}`,
      title: `${request.issueType || request.payload?.serviceType || "Service"} - ${request.unitName || "AC Unit"}`,
      customer: request.customer,
      address: request.address,
      customerId: request.customerId,
      customerEmail: request.customerEmail,
      customerPhone: request.customerPhone,
      unitId: request.unitId,
      unitName: request.unitName,
      unitType: request.payload?.unitType || request.unitName || "Installed AC Unit",
      issueType: request.issueType || request.payload?.serviceType || "Service Request",
      description: request.issue,
      status: "pending",
      priority: String(payload.priority || request.payload?.priority || "medium").toLowerCase(),
      scheduledDate: String(payload.scheduledDate || request.payload?.preferredDate || "TBD"),
      timeSlot: String(payload.timeSlot || request.payload?.preferredSchedule || "TBD"),
      assignedRole: "technician",
      branch: request.branch,
      payload: { ...commonPayload, createdAt: request.payload?.createdAt || nowIso },
    });
  }

  task.assignedTechnicianId = technicianId;
  task.assignedTechnicianName = technicianName;
  task.customer = request.customer;
  task.address = request.address;
  task.customerId = request.customerId;
  task.customerEmail = request.customerEmail;
  task.customerPhone = request.customerPhone;
  task.unitId = request.unitId;
  task.unitName = request.unitName;
  task.issueType = request.issueType || request.payload?.serviceType || task.issueType;
  task.description = request.issue;
  task.branch = request.branch || task.branch;
  task.payload = {
    ...(task.payload || {}),
    ...commonPayload,
    assignedTechnicianId: technicianId,
    assignedTechnicianName: technicianName,
  };

  await task.save();
  return task;
};

const requireAdmin = (req, res) => {
  if (req.authUser.role !== "admin" && req.authUser.role !== "superadmin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
};

const listServiceRequests = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return null;
    const branchQuery = req.authUser.role === "superadmin"
      ? {}
      : { $or: [{ branch: req.activeBranch }, { branch: "" }, { branch: { $exists: false } }] };
    const query = { ...branchQuery };
    const rawStatus = String(req.query?.status || "").trim();
    const status = rawStatus ? normalizeStatus(rawStatus) : "";
    const technicianId = String(req.query?.technicianId || "").trim();
    const unitId = String(req.query?.unitId || "").trim();

    if (status) query.status = status;
    if (technicianId) query.assignedTechnicianId = technicianId;
    if (unitId) query.unitId = unitId;

    const requests = await ServiceRequest.find(query).sort({ createdAt: -1 }).limit(200);
    return res.json({ requests: requests.map(hydrateRequestResponse) });
  } catch (error) {
    console.error("Failed to list service requests:", error);
    return res.status(500).json({ message: "Failed to list service requests" });
  }
};

const createServiceRequest = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return null;
    const { customer, issue, address, status = "Pending" } = req.body || {};
    if (!customer || !issue || !address) {
      return res.status(400).json({ message: "customer, issue, and address are required" });
    }
    const nowIso = new Date().toISOString();
    const request = await ServiceRequest.create({
      customer,
      issue,
      address,
      branch: req.authUser.role === "superadmin" ? (req.body?.branch || "") : req.activeBranch,
      status: normalizeStatus(status),
      customerId: String(req.body?.customerId || req.body?.userId || ""),
      customerEmail: String(req.body?.customerEmail || ""),
      customerPhone: String(req.body?.customerPhone || ""),
      unitId: String(req.body?.unitId || ""),
      unitName: String(req.body?.unitName || ""),
      issueType: String(req.body?.issueType || ""),
      assignedTechnicianId: String(req.body?.assignedTechnicianId || ""),
      assignedTechnicianName: String(req.body?.assignedTechnicianName || ""),
      payload: { ...req.body, createdAt: req.body?.createdAt || nowIso, updatedAt: req.body?.updatedAt || nowIso },
      createdBy: req.authUser._id,
    });
    return res.status(201).json({ request: hydrateRequestResponse(request) });
  } catch (error) {
    console.error("Failed to create service request:", error);
    return res.status(500).json({ message: "Failed to create service request" });
  }
};

const listMyServiceRequests = async (req, res) => {
  try {
    const requests = await ServiceRequest.find({ createdBy: req.authUser._id })
      .sort({ createdAt: -1 })
      .limit(200);
    return res.json({ requests: requests.map(hydrateRequestResponse) });
  } catch (error) {
    console.error("Failed to list my service requests:", error);
    return res.status(500).json({ message: "Failed to list service requests" });
  }
};

const listServiceCatalog = async (_req, res) => {
  return res.json({ offerings: getServiceCatalog(env.serviceCatalogJson) });
};

const createMyServiceRequest = async (req, res) => {
  try {
    const payload = req.body || {};
    const customerName = String(payload.customerName || payload.customer || getUserDisplayName(req.authUser)).trim();
    const issue = String(payload.issueDescription || payload.issue || payload.concern || "").trim();
    const address = String(payload.address || "").trim();
    const unitId = String(payload.unitId || "").trim();
    const service = findServiceOffering(
      getServiceCatalog(env.serviceCatalogJson),
      payload.serviceId || payload.serviceType || payload.issueType,
    );

    if (!customerName || !issue || !address) {
      return res.status(400).json({ message: "customer, issue, and address are required" });
    }
    if (!service) {
      return res.status(400).json({ message: "Choose a valid service type from the current service catalog." });
    }

    const unit = unitId ? await findOwnedUnit(unitId, req.authUser._id) : null;
    if (unitId && !unit) {
      return res.status(404).json({ message: "Selected installed AC unit was not found for this customer." });
    }

    if (unitId) {
      const existingActiveRequest = await ServiceRequest.findOne({
        createdBy: req.authUser._id,
        unitId,
        status: { $in: ACTIVE_REQUEST_STATUSES },
      }).sort({ createdAt: -1 });

      if (existingActiveRequest) {
        return res.status(409).json({
          message: "This AC unit already has an active service request. Please wait for it to be completed or cancel it before creating another one.",
          request: hydrateRequestResponse(existingActiveRequest),
        });
      }
    }

    const nowIso = new Date().toISOString();
    const timeline = Array.isArray(payload.timeline) && payload.timeline.length > 0
      ? payload.timeline
      : [
          buildTimelineEvent({
            title: "Request Submitted",
            description: "Service request submitted successfully.",
            actor: customerName || "Customer",
          }),
        ];
    const request = await ServiceRequest.create({
      customer: customerName,
      issue,
      address,
      branch: await getRequestBranch({ req, payload, unit }),
      status: normalizeStatus(payload.status || "Submitted"),
      customerId: String(payload.customerId || payload.userId || req.authUser._id || ""),
      customerEmail: String(payload.customerEmail || req.authUser.email || ""),
      customerPhone: String(payload.customerPhone || req.authUser.phone || ""),
      unitId,
      unitName: String(payload.unitName || unit?.modelName || ""),
      issueType: service.defaultIssueType,
      assignedTechnicianId: String(payload.assignedTechnicianId || ""),
      assignedTechnicianName: String(payload.assignedTechnicianName || ""),
      payload: {
        ...payload,
        userId: String(req.authUser._id || ""),
        customerName,
        serviceId: service.id,
        serviceType: service.title,
        issueType: service.defaultIssueType,
        // Pricing is resolved by the backend catalog. Client-provided prices
        // are deliberately ignored to keep Mobile, Web, Admin and Technician
        // records on one source of truth.
        pricing: service.pricing,
        unitId,
        unitName: String(payload.unitName || unit?.modelName || ""),
        unitSerialNumber: String(payload.unitSerialNumber || unit?.serialNumber || ""),
        qrCode: String(payload.qrCode || unit?.qrCode || ""),
        timeline,
        createdAt: payload.createdAt || nowIso,
        updatedAt: payload.updatedAt || nowIso,
      },
      createdBy: req.authUser._id,
    });

    await notifyUser({
      userId: req.authUser._id,
      title: "Service request submitted",
      message: `${request.issueType || "Service"} request for ${request.unitName || "your AC unit"} was submitted.`,
    });
    await notifyOperationalStaff({
      branch: request.branch,
      title: "New service request",
      message: `${request.customer || "A customer"} requested ${request.issueType || "AC service"}${request.unitName ? ` for ${request.unitName}` : ""}.`,
      type: "service",
      category: "service_request",
      targetId: String(request._id || request.id || ""),
      targetType: "service",
      dedupeKey: `service-request:${request._id || request.id}`,
    });

    return res.status(201).json({ request: hydrateRequestResponse(request) });
  } catch (error) {
    console.error("Failed to create service request:", error);
    return res.status(500).json({ message: "Failed to create service request" });
  }
};

const updateServiceRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const rawNextStatus = String(req.body?.status || "").trim();
    const nextStatus = rawNextStatus ? normalizeStatus(rawNextStatus) : "";

    const request = await ServiceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Service request not found" });
    }

    const role = req.authUser.role;
    if (role === "customer" || role === "technician") {
      const isOwner = String(request.createdBy || "") === String(req.authUser._id || "");
      if (!isOwner && role === "customer") {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (role === "technician") {
        return res.status(403).json({ message: "Technician progress is synchronized from the assigned work order." });
      }

      if (role === "customer" && nextStatus !== "Cancelled") {
        return res.status(403).json({ message: "Customers can only cancel requests." });
      }
    }

    const linkedTaskId = String(request.payload?.linkedTaskId || "").trim();
    let linkedTask = null;
    if (linkedTaskId) {
      const conditions = [{ taskCode: linkedTaskId }];
      if (mongoose.Types.ObjectId.isValid(linkedTaskId)) conditions.unshift({ _id: linkedTaskId });
      linkedTask = await Task.findOne({ $or: conditions });
    }
    if (nextStatus === "Completed" && linkedTask && String(linkedTask.status || "").toLowerCase() !== "completed") {
      return res.status(409).json({ message: "The assigned technician must submit proof and complete the work order before this request can be completed." });
    }
    if (nextStatus === "Cancelled" && linkedTask && !["completed", "cancelled"].includes(String(linkedTask.status || "").toLowerCase())) {
      linkedTask.status = "cancelled";
      linkedTask.completedAt = null;
      linkedTask.payload = {
        ...(linkedTask.payload || {}),
        status: "cancelled",
        cancellationReason: String(req.body?.description || "Service request cancelled by customer or administrator."),
        updatedAt: new Date().toISOString(),
      };
      await linkedTask.save();
    }

    request.status = nextStatus || request.status;
    request.assignedTechnicianId = String(req.body?.assignedTechnicianId || request.assignedTechnicianId || "");
    request.assignedTechnicianName = String(req.body?.assignedTechnicianName || request.assignedTechnicianName || "");
    const timeline = Array.isArray(request.payload?.timeline) ? request.payload.timeline : [];
    const nextTimeline = [
      ...timeline,
      buildTimelineEvent({
        title: `Status changed to ${request.status}`,
        description: req.body?.description || `Service request updated to ${request.status}.`,
        actor: req.authUser.name || req.authUser.email || req.authUser.role || "System",
      }),
    ];
    request.payload = {
      ...(request.payload || {}),
      ...req.body,
      status: request.status,
      timeline: nextTimeline,
      updatedAt: new Date().toISOString(),
    };

    const shouldCreateTask =
      request.assignedTechnicianId &&
      ["Assigned", "In Progress"].includes(request.status);
    const task = shouldCreateTask ? await upsertServiceTaskForRequest(request, req.body || {}) : null;
    if (task) {
      request.status = request.status === "In Progress" ? "In Progress" : "Assigned";
      request.assignedTechnicianId = task.assignedTechnicianId;
      request.assignedTechnicianName = task.assignedTechnicianName;
      request.payload = {
        ...(request.payload || {}),
        linkedTaskId: String(task._id || task.id || ""),
        taskCode: task.taskCode,
        status: request.status,
        assignedTechnicianId: task.assignedTechnicianId,
        assignedTechnicianName: task.assignedTechnicianName,
      };

      await notifyUser({
        userId: task.assignedTechnicianId,
        title: "New service task assigned",
        message: `${request.customer}'s ${request.unitName || "AC unit"} service request is assigned to you.`,
      });
    }

    if (request.status === "Completed") {
      request.payload = {
        ...(request.payload || {}),
        completedAt: request.payload?.completedAt || new Date().toISOString(),
      };
    }

    await request.save();
    if (["Assigned", "In Progress", "Completed", "Cancelled"].includes(request.status)) {
      await notifyUser({
        userId: request.customerId,
        title: "Service request updated",
        message: `Your service request is now ${request.status}.`,
      });
    }
    await notifyOperationalStaff({
      branch: request.branch,
      title: "Service request updated",
      message: `${request.issueType || "Service request"} for ${request.customer || "a customer"} is now ${request.status}.`,
      type: "service",
      category: "service_request",
      severity: request.status === "Cancelled" ? "warning" : "info",
      targetId: String(request._id || request.id || ""),
      targetType: "service",
      dedupeKey: `service-request:${request._id || request.id}:${request.status}`,
    });
    return res.json({ request: hydrateRequestResponse(request) });
  } catch (error) {
    console.error("Failed to update service request status:", error);
    return res.status(500).json({ message: "Failed to update service request" });
  }
};

module.exports = {
  listServiceRequests,
  createServiceRequest,
  listMyServiceRequests,
  listServiceCatalog,
  createMyServiceRequest,
  updateServiceRequestStatus,
};

