const mongoose = require("mongoose");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const Unit = require("../models/Unit");
const User = require("../models/User");
const {
  createDedupedNotification,
  notifyOperationalStaff,
} = require("../services/operationalNotificationService");
const { resolvePreferredBranch } = require("../domain/branchRouting");
const { getServiceCatalog, findServiceOffering } = require("../domain/serviceCatalog");
const {
  normalizeServiceRequestStatus,
  canTransitionServiceRequest,
  canCustomerCancelServiceRequest,
  resolveServiceAppointmentDate,
} = require("../domain/serviceRequestWorkflow");
const env = require("../config/env");
const { servicePaymentSummary } = require("../domain/servicePayment");
const { getScheduledDateError } = require("../utils/scheduling");
const { formatServiceAddress } = require("../domain/serviceAddress");
const { cancelWarrantyForRequest, reconcileCancelledWarranty } = require("../domain/warrantyCancellation");
const { validateWarrantyAssignmentQuota } = require("../domain/technicianServiceQuota");
const { assertNoTaskScheduleConflict } = require("../domain/taskScheduleConflict");

const normalizeStatus = (value = "", fallback = "Pending") =>
  normalizeServiceRequestStatus(value, fallback);

const ACTIVE_REQUEST_STATUSES = ["Submitted", "Reviewed", "Assigned", "In Progress", "Pending"];

const hydrateRequestResponse = (request) => {
  const json = request.toJSON ? request.toJSON() : request;
  const payload = request.payload && Object.keys(request.payload).length ? request.payload : null;
  if (!payload) return { ...json, servicePayment: servicePaymentSummary(request) };
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
    servicePayment: servicePaymentSummary(request),
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

const notifyUser = async ({ userId, title, message, type = "service", targetId = "", targetType = "service_request", route = "/customer/services", dedupeKey = "" }) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  try {
    return await createDedupedNotification({
      user: userId,
      type,
      category: "service_request",
      title,
      message,
      targetType,
      route,
      targetId: String(targetId || ""),
      dedupeKey,
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
    ? await User.findById(technicianId).select("name name_first name_last email role accountStatus isDeleted activeBranch assignedBranch serviceQuota")
    : null;
  if (
    !technician ||
    technician.role !== "technician" ||
    technician.isDeleted ||
    ["disabled", "deleted"].includes(String(technician.accountStatus || ""))
  ) {
    const error = new Error("Choose an active technician account.");
    error.statusCode = 400;
    throw error;
  }
  const technicianBranch = String(technician.activeBranch || technician.assignedBranch || "").trim();
  if (request.branch && technicianBranch && request.branch !== technicianBranch) {
    const error = new Error("The technician must belong to the service request branch.");
    error.statusCode = 409;
    throw error;
  }
  const quotaError = validateWarrantyAssignmentQuota({ request, technician });
  if (quotaError) {
    const error = new Error(quotaError);
    error.statusCode = 409;
    throw error;
  }
  const technicianName = getTechnicianDisplayName(technician);
  const existingTaskId = String(request.payload?.linkedTaskId || payload.linkedTaskId || "").trim();
  const nowIso = new Date().toISOString();
  const commonPayload = {
    preferredDate: request.payload?.preferredDate || "",
    preferredSchedule: request.payload?.preferredSchedule || "",
    pricing: request.payload?.pricing || null,
    warrantyClaimId: request.payload?.warrantyClaimId || "",
    requestId: String(request._id || request.id || ""),
    source: "service_request",
    customerName: request.customer,
    customerId: request.customerId,
    serviceType: request.payload?.serviceType || request.issueType || "Service Request",
    issueDescription: request.issue,
    customerNotes: request.payload?.notes || "",
    customerOther: request.payload?.other || request.payload?.otherIssue || request.payload?.otherDescription || "",
    unitSerialNumber: request.payload?.unitSerialNumber || "",
    qrCode: request.payload?.qrCode || "",
    // Assigning a technician from Admin is the activation step for service
    // work. Installation-order tasks are still activated by order dispatch.
    status: "in-progress",
    activatedAt: request.payload?.activatedAt || nowIso,
    activationSource: "admin_service_assignment",
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
      address: formatServiceAddress(request.address, request.payload || {}),
      customerId: request.customerId,
      customerEmail: request.customerEmail,
      customerPhone: request.customerPhone,
      unitId: request.unitId,
      unitName: request.unitName,
      unitType: request.payload?.unitType || request.unitName || "Installed AC Unit",
      issueType: request.issueType || request.payload?.serviceType || "Service Request",
      description: request.issue,
      status: "in-progress",
      priority: String(payload.priority || request.payload?.priority || "medium").toLowerCase(),
      scheduledDate: String(payload.scheduledDate || request.payload?.preferredDate || "TBD"),
      timeSlot: String(payload.timeSlot || request.payload?.preferredSchedule || "TBD"),
      assignedRole: "technician",
      branch: request.branch,
      payload: { ...commonPayload, createdAt: request.payload?.createdAt || nowIso },
    });
  }
  if (String(task.payload?.requestId || task.requestId || "") && String(task.payload?.requestId || task.requestId) !== String(request._id)) {
    const error = new Error("The linked work order belongs to another service request."); error.statusCode = 409; throw error;
  }

  const previousTechnicianId = String(task.assignedTechnicianId || "").trim();
  const currentTaskStatus = String(task.status || "pending").trim().toLowerCase();
  const isReassignment = Boolean(previousTechnicianId && previousTechnicianId !== technicianId);
  if (isReassignment) {
    task.payload = { ...(task.payload || {}), checkIn: null, serviceLogs: [], findings: "", resolution: "", serviceActions: [], serviceHistoryId: "" };
    task.proof = {};
  }
  const shouldActivateTask =
    !["completed", "cancelled"].includes(currentTaskStatus) &&
    (isReassignment || ["pending", "accepted", "on-hold", "failed", "rescheduled"].includes(currentTaskStatus));

  task.assignedTechnicianId = technicianId;
  task.assignedTechnicianName = technicianName;
  task.customer = request.customer;
  task.address = formatServiceAddress(request.address, request.payload || {});
  task.customerId = request.customerId;
  task.customerEmail = request.customerEmail;
  task.customerPhone = request.customerPhone;
  task.unitId = request.unitId;
  task.unitName = request.unitName;
  task.issueType = request.issueType || request.payload?.serviceType || task.issueType;
  task.description = request.issue;
  task.branch = request.branch || task.branch;
  task.scheduledDate = String(payload.scheduledDate || request.payload?.scheduledDate || task.scheduledDate);
  task.timeSlot = String(payload.timeSlot || request.payload?.timeSlot || task.timeSlot);
  if (shouldActivateTask) task.status = "in-progress";
  task.payload = {
    ...(task.payload || {}),
    ...commonPayload,
    assignedTechnicianId: technicianId,
    assignedTechnicianName: technicianName,
    status: task.status,
    activatedAt: task.payload?.activatedAt || nowIso,
  };

  await assertNoTaskScheduleConflict({
    scheduledDate: task.scheduledDate,
    timeSlot: task.timeSlot,
    participantIds: [technicianId],
    excludeTaskId: task._id,
  });
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
    const status = rawStatus ? normalizeStatus(rawStatus, null) : "";
    const technicianId = String(req.query?.technicianId || "").trim();
    const unitId = String(req.query?.unitId || "").trim();

    if (rawStatus && !status) return res.status(400).json({ message: "Invalid service request status." });
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
    const scheduleError = getScheduledDateError(
      req.body?.scheduledDate || req.body?.preferredDate,
      "Service date",
    );
    if (scheduleError) return res.status(400).json({ message: scheduleError });
    const normalizedStatus = normalizeStatus(status, null);
    if (!normalizedStatus) {
      return res.status(400).json({ message: "Invalid service request status." });
    }
    if (!["Pending", "Submitted", "Reviewed"].includes(normalizedStatus)) return res.status(400).json({ message: "Create the request first, then assign and complete its technician work order." });
    const nowIso = new Date().toISOString();
    const request = await ServiceRequest.create({
      customer,
      issue,
      address,
      branch: req.authUser.role === "superadmin" ? (req.body?.branch || "") : req.activeBranch,
      status: normalizedStatus,
      customerId: String(req.body?.customerId || req.body?.userId || ""),
      customerEmail: String(req.body?.customerEmail || ""),
      customerPhone: String(req.body?.customerPhone || ""),
      unitId: String(req.body?.unitId || ""),
      unitName: String(req.body?.unitName || ""),
      issueType: String(req.body?.issueType || ""),
      assignedTechnicianId: String(req.body?.assignedTechnicianId || ""),
      assignedTechnicianName: String(req.body?.assignedTechnicianName || ""),
      payload: { ...req.body, status: normalizedStatus, createdAt: nowIso, updatedAt: nowIso },
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
    const requests = await ServiceRequest.find({ $or: [{ createdBy: req.authUser._id }, { customerId: String(req.authUser._id) }] })
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
    const idempotencyKey = String(req.get("Idempotency-Key") || payload.idempotencyKey || "").trim().slice(0, 160);
    const customerName = String(payload.customerName || payload.customer || getUserDisplayName(req.authUser)).trim();
    const issue = String(payload.issueDescription || payload.issue || payload.concern || "").trim();
    const rawAddress = String(payload.address || "").trim();
    const address = formatServiceAddress(rawAddress, payload);
    const unitId = String(payload.unitId || "").trim();
    const service = findServiceOffering(
      getServiceCatalog(env.serviceCatalogJson),
      payload.serviceId || payload.serviceType || payload.issueType,
    );

    if (!customerName || !issue || !rawAddress) {
      return res.status(400).json({ message: "customer, issue, and address are required" });
    }
    if (!service) {
      return res.status(400).json({ message: "Choose a valid service type from the current service catalog." });
    }
    const scheduleError = getScheduledDateError(payload.preferredDate, "Preferred date");
    if (scheduleError) return res.status(400).json({ message: scheduleError });
    if (!payload.preferredDate) {
      return res.status(400).json({ message: "Choose a preferred service date." });
    }

    if (idempotencyKey) {
      const existingRequest = await ServiceRequest.findOne({
        createdBy: req.authUser._id,
        idempotencyKey,
      });
      if (existingRequest) {
        return res.status(200).json({ request: hydrateRequestResponse(existingRequest), replayed: true });
      }
    }

    let unit = unitId ? await findOwnedUnit(unitId, req.authUser._id) : null;
    if (unit) unit = await reconcileCancelledWarranty(unit);
    if (unitId && !unit) {
      return res.status(404).json({ message: "Selected installed AC unit was not found for this customer." });
    }
    if (["maintenance", "cleaning", "regular_cleaning", "deep_cleaning", "repair"].includes(service.id) && !unit) return res.status(400).json({ message: "Select your registered AC unit for this service." });
    if (unit && ["on_hold", "retired"].includes(unit.status)) return res.status(409).json({ message: "This AC unit is unavailable for service booking. Contact the branch team for assistance." });

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

      const activeWarrantyClaim = (unit?.warranty?.claims || []).find((claim) =>
        ["submitted", "under_review", "approved"].includes(String(claim?.status || "").toLowerCase()),
      );
      if (activeWarrantyClaim) {
        return res.status(409).json({
          message: `Warranty claim ${activeWarrantyClaim.claimId || ""} is already ${String(activeWarrantyClaim.status || "being reviewed").replace(/_/g, " ")}. Please wait for that workflow instead of creating a duplicate service request.`,
          claim: activeWarrantyClaim,
        });
      }
    }

    const nowIso = new Date().toISOString();
    const timeline = [
          buildTimelineEvent({
            title: "Request Submitted",
            description: "Service request submitted successfully.",
            actor: customerName || "Customer",
          }),
        ];
    const branch = await getRequestBranch({ req, payload, unit });
    if (!branch) {
      return res.status(422).json({
        message: "This service address is outside the configured service areas.",
      });
    }
    const request = await ServiceRequest.create({
      customer: customerName,
      issue,
      address,
      branch,
      status: "Submitted",
      customerId: String(req.authUser._id),
      customerEmail: String(req.authUser.email || ""),
      customerPhone: String(req.authUser.phone || ""),
      unitId,
      unitName: String(payload.unitName || unit?.modelName || ""),
      issueType: service.defaultIssueType,
      assignedTechnicianId: "",
      assignedTechnicianName: "",
      payload: {
        address,
        city: String(payload.city || unit?.installation?.city || ""),
        province: String(payload.province || unit?.installation?.province || ""),
        barangay: String(payload.barangay || ""),
        preferredDate: payload.preferredDate,
        preferredSchedule: String(payload.preferredSchedule || ""),
        notes: String(payload.notes || "").trim().slice(0, 2000),
        other: String(payload.other || payload.otherIssue || payload.otherDescription || "").trim().slice(0, 1000),
        issueDescription: issue,
        status: "Submitted",
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
        unitName: String(unit?.modelName || payload.unitName || ""),
        unitSerialNumber: String(unit?.serialNumber || ""),
        qrCode: String(unit?.qrCode || ""),
        timeline,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      createdBy: req.authUser._id,
      idempotencyKey,
    });

    await notifyUser({
      userId: req.authUser._id,
      title: "Service request submitted",
      message: `${request.issueType || "Service"} request for ${request.unitName || "your AC unit"} was submitted.`,
      targetId: String(request._id || request.id || ""),
      dedupeKey: `service-submitted:${request._id || request.id}`,
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
    if (error?.code === 11000) {
      const idempotencyKey = String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim().slice(0, 160);
      const existingRequest = idempotencyKey
        ? await ServiceRequest.findOne({ createdBy: req.authUser._id, idempotencyKey })
        : null;
      if (existingRequest) return res.status(200).json({ request: hydrateRequestResponse(existingRequest), replayed: true });
    }
    console.error("Failed to create service request:", error);
    return res.status(500).json({ message: "Failed to create service request" });
  }
};

const updateServiceRequestStatus = async (req, res) => {
  try {
    // Pricing and collection have dedicated validated endpoints. Status changes
    // must never forge a paid state or warranty exemption through Mixed payload.
    for (const key of ["pricing", "servicePayment", "warrantyClaimId"]) delete req.body?.[key];
    const { id } = req.params;
    const rawNextStatus = String(req.body?.status || "").trim();
    const nextStatus = rawNextStatus ? normalizeStatus(rawNextStatus, null) : "";
    if (!nextStatus) return res.status(400).json({ message: "Choose a valid service request status." });

    const request = await ServiceRequest.findById(id);
    if (!request) {
      return res.status(404).json({ message: "Service request not found" });
    }

    const role = req.authUser.role;
    if (role === "admin") {
      const requestBranch = String(request.branch || "").trim();
      if (requestBranch && requestBranch !== req.activeBranch) {
        return res.status(403).json({ message: "This service request belongs to another branch." });
      }
    }
    if (role === "customer" || role === "technician") {
      const isOwner = [request.createdBy, request.customerId].some((value) => String(value || "") === String(req.authUser._id || ""));
      if (!isOwner && role === "customer") {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (role === "technician") {
        return res.status(403).json({ message: "Technician progress is synchronized from the assigned work order." });
      }

      if (role === "customer" && nextStatus !== "Cancelled") {
        return res.status(403).json({ message: "Customers can only cancel requests." });
      }
      if (role === "customer" && !canCustomerCancelServiceRequest(request.status)) {
        return res.status(409).json({ message: "This request can no longer be cancelled because work has already started." });
      }
      // Cancellation is the customer's only write permission, not a way to
      // alter assignment, history, ownership, or proof fields in the payload.
      req.body = { status: "Cancelled", description: String(req.body?.description || "Customer cancelled the request.").slice(0, 1000) };
    }
    if (!canTransitionServiceRequest(request.status, nextStatus)) {
      return res.status(409).json({
        message: `Service request cannot move from ${request.status} to ${nextStatus}.`,
      });
    }

    const savedPreferredDate = String(request.payload?.preferredDate || '').trim();
    if (Object.hasOwn(req.body || {}, 'preferredDate') && String(req.body.preferredDate || '').trim() !== savedPreferredDate) {
      return res.status(409).json({ message: 'The customer-selected appointment date cannot be changed by an administrator.' });
    }
    delete req.body?.preferredDate;
    const appointment = resolveServiceAppointmentDate({
      preferredDate: savedPreferredDate,
      scheduledDate: request.payload?.scheduledDate,
      requestedDate: req.body?.scheduledDate,
    });
    if (appointment.error) return res.status(409).json({ message: appointment.error });
    if (Object.hasOwn(req.body || {}, 'scheduledDate') && appointment.date) {
      req.body.scheduledDate = appointment.date;
    }
    if (['Assigned', 'In Progress'].includes(nextStatus)) {
      const scheduledDate = appointment.date;
      const timeSlot = String(req.body?.timeSlot || request.payload?.timeSlot || request.payload?.preferredSchedule || '').trim();
      const scheduleError = getScheduledDateError(scheduledDate, 'Appointment date');
      if (!scheduledDate || scheduleError || !timeSlot || timeSlot === 'TBD' || timeSlot.length > 80) return res.status(400).json({ message: scheduleError || 'Choose an appointment date and time slot before assigning the technician.' });
      req.body = { ...req.body, scheduledDate, timeSlot };
    }
    const scheduleChanged = ['scheduledDate', 'timeSlot'].some(key => Object.hasOwn(req.body || {}, key) && String(req.body[key]) !== String(request.payload?.[key] || ''));
    if (scheduleChanged && ['Completed', 'Cancelled'].includes(request.status)) return res.status(409).json({ message: 'Closed service requests cannot be rescheduled.' });
    const linkedTaskId = String(request.payload?.linkedTaskId || "").trim();
    let linkedTask = null;
    if (linkedTaskId) {
      const conditions = [{ taskCode: linkedTaskId }];
      if (mongoose.Types.ObjectId.isValid(linkedTaskId)) conditions.unshift({ _id: linkedTaskId });
      linkedTask = await Task.findOne({ $or: conditions });
      if (linkedTask && String(linkedTask.requestId || linkedTask.payload?.requestId || "") !== String(request._id)) return res.status(409).json({ message: "The linked work order does not match this service request. Ask the branch team to review it." });
    }
    if (linkedTask?.payload?.visitAttempt?.awaitingAdmin && nextStatus !== 'Cancelled') {
      return res.status(409).json({ message: 'Use Visit follow-up to confirm the next visit before changing this assignment or schedule.' });
    }
    if (nextStatus === "Completed" && (!linkedTask || String(linkedTask.status || "").toLowerCase() !== "completed")) {
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

    const previousRequestStatus = String(request.status || "");
    const previousTechnicianId = String(request.assignedTechnicianId || "");
    const requestedTechnicianId = String(req.body?.assignedTechnicianId || "").trim();
    if (previousTechnicianId && requestedTechnicianId && requestedTechnicianId !== previousTechnicianId) {
      return res.status(409).json({
        message: "This service request already has a permanently assigned technician. The normal assignment flow cannot replace that technician.",
      });
    }
    request.status = nextStatus || request.status;
    request.assignedTechnicianId = String(req.body?.assignedTechnicianId || request.assignedTechnicianId || "");
    request.assignedTechnicianName = String(req.body?.assignedTechnicianName || request.assignedTechnicianName || "");
    // Service-request assignment is also its Admin activation action. This
    // prevents a pending task that technicians cannot start and keeps the
    // request and task on the same lifecycle status.
    if (request.assignedTechnicianId && ["Assigned", "In Progress"].includes(request.status)) {
      request.status = "In Progress";
    }
    if (["Assigned", "In Progress"].includes(nextStatus) && !String(req.body?.assignedTechnicianId || request.assignedTechnicianId || "").trim()) return res.status(400).json({ message: "Assign an active technician before starting this service request." });
    const timeline = Array.isArray(request.payload?.timeline) ? request.payload.timeline : [];
    const statusChanged = previousRequestStatus !== request.status;
    const technicianChanged = previousTechnicianId !== String(request.assignedTechnicianId || "");
    const nextTimeline = statusChanged || technicianChanged || scheduleChanged
      ? [
          ...timeline,
          buildTimelineEvent({
            title: scheduleChanged ? 'Service appointment updated' : technicianChanged ? "Technician assignment updated" : `Status changed to ${request.status}`,
            description: req.body?.description || (scheduleChanged ? `${req.body.scheduledDate} · ${req.body.timeSlot}` : technicianChanged
              ? `${request.assignedTechnicianName || "A technician"} was assigned to this service request.`
              : `Service request updated to ${request.status}.`),
            actor: req.authUser.name || req.authUser.email || req.authUser.role || "System",
          }),
        ]
      : timeline;
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
      request.status = "In Progress";
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

    }

    if (request.status === "Completed") {
      request.payload = {
        ...(request.payload || {}),
        completedAt: request.payload?.completedAt || new Date().toISOString(),
      };
    }

    await request.save();
    await cancelWarrantyForRequest(request, String(req.body?.description || 'The associated service visit was cancelled.'));
    // The technician must not receive a task/schedule push until the service
    // request and its linked-task reference have both been persisted.
    if (task && (statusChanged || technicianChanged || scheduleChanged)) {
      await notifyUser({
        userId: task.assignedTechnicianId,
        title: scheduleChanged && !technicianChanged ? "Service appointment updated" : "New service task assigned",
        message: `${request.customer}'s ${request.unitName || "AC unit"} service appointment: ${task.scheduledDate} · ${task.timeSlot}.`,
        targetId: String(task._id || task.id || ""),
        targetType: "task",
        route: "/technician/tasks",
        dedupeKey: scheduleChanged ? `service-task-schedule:${task._id}:${task.assignedTechnicianId}:${task.scheduledDate}:${task.timeSlot}:${nextTimeline.length}` : `service-task-assigned:${task._id || task.id}:${task.assignedTechnicianId}`,
      });
    }
    if ((statusChanged || technicianChanged || scheduleChanged) && ["Assigned", "In Progress", "Completed", "Cancelled"].includes(request.status)) {
      await notifyUser({
        userId: request.customerId,
        title: scheduleChanged ? 'Service appointment updated' : technicianChanged ? "Technician assignment updated" : "Service request updated",
        message: scheduleChanged ? `Your service appointment is ${req.body.scheduledDate} · ${req.body.timeSlot}.` : technicianChanged
          ? `${request.assignedTechnicianName || "A technician"} is now assigned to your service request.`
          : `Your service request is now ${request.status}.`,
        targetId: String(request._id || request.id || ""),
        dedupeKey: scheduleChanged ? `service-schedule:${request._id}:${req.body.scheduledDate}:${req.body.timeSlot}:${nextTimeline.length}` : technicianChanged
          ? `service-technician:${request._id || request.id}:${request.assignedTechnicianId}`
          : `service-status:${request._id || request.id}:${request.status}`,
      });
    }
    if (statusChanged || technicianChanged) {
      await notifyOperationalStaff({
        branch: request.branch,
        title: technicianChanged ? "Technician assignment updated" : "Service request updated",
        message: technicianChanged
          ? `${request.assignedTechnicianName || "A technician"} is now assigned to ${request.issueType || "a service request"} for ${request.customer || "a customer"}.`
          : `${request.issueType || "Service request"} for ${request.customer || "a customer"} is now ${request.status}.`,
        type: "service",
        category: "service_request",
        severity: request.status === "Cancelled" ? "warning" : "info",
        targetId: String(request._id || request.id || ""),
        targetType: "service",
        dedupeKey: technicianChanged
          ? `service-request-tech:${request._id || request.id}:${request.assignedTechnicianId}`
          : `service-request:${request._id || request.id}:${request.status}`,
      });
    }
    return res.json({ request: hydrateRequestResponse(request) });
  } catch (error) {
    console.error("Failed to update service request status:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to update service request" });
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

