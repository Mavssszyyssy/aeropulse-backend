const mongoose = require("mongoose");
const crypto = require("node:crypto");
const { awaitingVisitFollowUp, FOLLOW_UP_REQUIRED } = require('../domain/visitAttempt');
const { cancelWarrantyForRequest } = require('../domain/warrantyCancellation');
const Task = require("../models/Task");
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const Unit = require("../models/Unit");
const ServiceRequest = require("../models/ServiceRequest");
const { servicePaymentSummary, servicePaymentBlocker, servicePaymentRecord } = require("../domain/servicePayment");
const { serviceCosts, validateServiceCosts } = require("../domain/serviceCosts");
const { resolveServiceVisitBranch } = require("../domain/serviceVisitBranch");
const { buildOrderPaymentSnapshot } = require("../domain/orderPayment");
const Notification = require("../models/Notification");
const { notifyOperationalStaff, createDedupedNotification } = require("../services/operationalNotificationService");
const ServiceHistory = require("../models/ServiceHistory");
const { calculateMaintenanceRecommendation } = require("../domain/ampMaintenanceService");
const { BRANCH_PRIORITY, resolvePreferredBranch } = require("../domain/branchRouting");
const { buildActivatedWarranty, appendWarrantyEvent, effectiveWarrantyStatus, getWarrantyCoverage } = require("../domain/warrantyService");
const { validateTechnicianTaskCompletion } = require("../domain/technicianTaskCompletion");
const { completeServiceForUnit } = require("../domain/serviceCompletionService");
const { assessServiceEvidence, serviceTypeFor } = require("../domain/serviceEvidence");
const { formatDateKeyInTimeZone, parseInstallationDateTime } = require("../utils/dateTime");
const { buildTaskScheduleDetails, normalizeTaskSchedule } = require("../domain/taskSchedule");
const {
  getTaskMutationBlocker,
  hasVerifiedTaskCheckIn,
  installationArrivalBlocker,
  isOrderInstallationTask,
  normalizeTaskStatus: normalizeStatus,
  parseTaskStatus,
} = require("../domain/taskWorkflow");

const branchScopeQuery = (req) => {
  if (req.authUser.role === "superadmin") return {};
  const branch = req.activeBranch;
  if (!branch) return {};
  return { $or: [{ branch }, { branch: "" }, { branch: { $exists: false } }] };
};

const buildCustomerTaskScopeQuery = (user = {}) => {
  const customerId = String(user._id || user.id || "").trim();
  const customerEmail = String(user.email || "").trim();
  const ownership = [];

  if (customerId) {
    ownership.push(
      { customerId },
      { "payload.customerId": customerId },
      { "payload.userId": customerId },
    );
  }
  if (customerEmail) {
    const escapedEmail = customerEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    ownership.push(
      { customerEmail: new RegExp(`^${escapedEmail}$`, "i") },
      { "payload.customerEmail": new RegExp(`^${escapedEmail}$`, "i") },
    );
  }

  return ownership.length ? { $or: ownership } : { _id: { $exists: false } };
};

const findTaskForRequest = async (taskId, req) => {
  const conditions = [{ taskCode: taskId }];
  if (mongoose.Types.ObjectId.isValid(taskId)) {
    conditions.unshift({ _id: taskId });
  }
  const scopes = [{ $or: conditions }, branchScopeQuery(req)];
  if (req.authUser.role === "technician") {
    const technicianId = String(req.authUser._id || "");
    scopes.push({ $or: [{ assignedTechnicianId: technicianId }, { "schedule.teamMemberIds": technicianId }] });
  }
  return Task.findOne({ $and: scopes });
};

const getTaskSerialNumbers = (task) => {
  const payload = task?.payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const directSerials = Array.isArray(payload.serialNumbers)
    ? payload.serialNumbers
    : [];
  return Array.from(
    new Set(
      [...directSerials, ...items
        .flatMap((item) => [
          ...(Array.isArray(item.serialNumbers) ? item.serialNumbers : []),
          ...(Array.isArray(item.serialUnits)
            ? item.serialUnits.map((unit) => unit?.serialNumber)
            : []),
        ])]
        .map((serial) => String(serial || "").trim())
        .filter(Boolean),
    ),
  );
};

const getAmpRegistrations = (task) => {
  const registrations = task?.payload?.ampRegistrations;
  return registrations && typeof registrations === "object" && !Array.isArray(registrations)
    ? registrations
    : {};
};

const getRegistrationProgress = (task) => {
  const requiredSerials = getTaskSerialNumbers(task);
  const registrations = getAmpRegistrations(task);
  const registeredSerials = requiredSerials.filter(
    (serial) => registrations[serial]?.status === "registered",
  );
  const heldSerials = requiredSerials.filter(
    (serial) => registrations[serial]?.status === "defective_hold",
  );
  const pendingSerials = requiredSerials.filter(
    (serial) => !["registered", "defective_hold"].includes(registrations[serial]?.status),
  );

  return {
    requiredSerials,
    registeredSerials,
    heldSerials,
    pendingSerials,
    totalRequired: requiredSerials.length,
    totalRegistered: registeredSerials.length,
    totalHeld: heldSerials.length,
    isComplete: requiredSerials.length === 0 || registeredSerials.length === requiredSerials.length,
  };
};

const assertCanCompleteTask = (task) => {
  const progress = getRegistrationProgress(task);
  if (progress.isComplete) return null;

  if (progress.heldSerials.length > 0) {
    return {
      status: 409,
      message: "This task is on hold because at least one AC unit was marked defective during installation.",
      progress,
    };
  }

  return {
    status: 409,
    message: "Register all assigned AC unit QR labels before completing this task.",
    progress,
  };
};

const assertInstallationProof = (task, proof, payload = {}) => {
  // An installation is complete once its assigned QR unit is registered and
  // the technician has supplied an installed-unit photo. Customer details are
  // authoritative order data, so technicians must never retype or sign them.
  const isService = Boolean(task.payload?.requestId || task.unitId);
  if (getTaskSerialNumbers(task).length === 0 && !isService) return null;

  const hasInstallationPhoto = (proof?.afterPhotos || []).some((photo) =>
    Boolean(String(photo?.uri || "").trim()),
  );
  if (hasInstallationPhoto) return null;

  return {
    status: 409,
    message: isService ? "Service proof is incomplete. Add an after-service photo before closing this work order." : "Installation proof is incomplete. Add an installed-unit photo before closing this work order.",
  };
};

const findLinkedOrderForTask = async (task) => {
  const payload = task?.payload || {};
  // Keep completion syncing resilient for older and manually created tasks,
  // where the order linkage may be present on the task response instead of
  // inside its payload.
  const orderId = String(payload.orderId || task?.orderId || "").trim();
  const orderCode = String(payload.orderCode || task?.orderCode || "").trim();
  const conditions = [];
  if (mongoose.Types.ObjectId.isValid(orderId)) conditions.push({ _id: orderId });
  if (orderCode) conditions.push({ orderCode });
  if (conditions.length === 0) return null;
  return Order.findOne({ $or: conditions });
};

const { isCodOrder, hasCodCollection, codCollectionBlocker } = require("../utils/codPayment");
const getOrderCompletionBlocker = async (task) => {
  const order = await findLinkedOrderForTask(task);
  if (!order || order.workflowStatus === "complete") return null;
  if (order.workflowStatus === "to_install") {
    if (isCodOrder(order) && !hasCodCollection(order)) return "Confirm cash collection after GPS check-in before completing this COD order.";
    return null;
  }
  return `Order ${order.orderCode} must be marked dispatched by an admin before the installation can be completed.`;
};

const findProductSerialUnit = async (serialNumber) => {
  const serialRegex = new RegExp(`^${String(serialNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const product = await Product.findOne({
    serialUnits: { $elemMatch: { $or: [
      { serialNumber: serialRegex },
      { qrUnitId: serialRegex },
      { serialAliases: serialRegex },
    ] } },
  }).select("-imageData");

  if (!product) return { product: null, serialUnit: null };
  const serialUnit = (product.serialUnits || []).find(
    (unit) => [unit.serialNumber, unit.qrUnitId, ...(unit.serialAliases || [])]
      .some((value) => String(value || "").toLowerCase() === String(serialNumber || "").toLowerCase()),
  );
  return { product, serialUnit };
};

const getTechnicianDisplayName = (technician = {}) =>
  technician.name ||
  `${technician.name_first || ""} ${technician.name_last || ""}`.trim() ||
  "Technician";

const asPhotoList = (value, fallbackLabel) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          uri: item.trim(),
          label: fallbackLabel,
          capturedAt: new Date().toISOString(),
        };
      }
      return {
        uri: String(item?.uri || item?.url || "").trim(),
        label: String(item?.label || fallbackLabel || `Photo ${index + 1}`).trim(),
        capturedAt: item?.capturedAt || new Date().toISOString(),
      };
    })
    .filter((item) => item.uri);
};

const buildTaskProof = ({ task, payload, req, nextStatus }) => {
  const currentProof = task.proof || {};
  const incomingProof = payload.proof && typeof payload.proof === "object" ? payload.proof : {};
  const beforePhotos = asPhotoList(
    incomingProof.beforePhotos || payload.beforePhotos || payload.beforePhotoUri,
    "Before service",
  );
  const afterPhotos = asPhotoList(
    incomingProof.afterPhotos || payload.afterPhotos || payload.afterPhotoUri,
    "After service",
  );
  const customerSignature =
    incomingProof.customerSignature && typeof incomingProof.customerSignature === "object"
      ? incomingProof.customerSignature
      : {};
  const signatureName = String(
    customerSignature.name ||
      payload.customerSignatureName ||
      payload.signatureName ||
      "",
  ).trim();
  const signatureValue = String(
    customerSignature.signature ||
      payload.customerSignature ||
      payload.signature ||
      signatureName ||
      "",
  ).trim();
  const orderCustomer = {
    ...(currentProof.customer && typeof currentProof.customer === "object" ? currentProof.customer : {}),
    ...(incomingProof.customer && typeof incomingProof.customer === "object" ? incomingProof.customer : {}),
    name: String(task.customer || payload.customerName || payload.customer || "Customer").trim(),
    customerId: String(task.customerId || task.payload?.customerId || "").trim(),
    source: "assigned_order",
  };
  const hasIncomingProof =
    beforePhotos.length > 0 ||
    afterPhotos.length > 0 ||
    signatureName ||
    signatureValue ||
    payload.proofNotes ||
    incomingProof.notes;

  if (!hasIncomingProof && nextStatus !== "completed") {
    return currentProof;
  }

  const submittedAt =
    incomingProof.submittedAt ||
    payload.proofSubmittedAt ||
    (nextStatus === "completed" || hasIncomingProof ? new Date().toISOString() : currentProof.submittedAt);

  return {
    beforePhotos: beforePhotos.length ? beforePhotos : currentProof.beforePhotos || [],
    afterPhotos: afterPhotos.length ? afterPhotos : currentProof.afterPhotos || [],
    customer: orderCustomer,
    customerSignature: {
      ...(currentProof.customerSignature || {}),
      ...customerSignature,
      name: signatureName || currentProof.customerSignature?.name || "",
      signature: signatureValue || currentProof.customerSignature?.signature || "",
      signedAt:
        customerSignature.signedAt ||
        payload.customerSignedAt ||
        (signatureName || signatureValue ? new Date().toISOString() : currentProof.customerSignature?.signedAt || ""),
    },
    technicianName:
      String(incomingProof.technicianName || payload.technicianName || "").trim() ||
      task.assignedTechnicianName ||
      getTechnicianDisplayName(req.authUser),
    submittedAt,
    notes: String(incomingProof.notes || payload.proofNotes || payload.notes || currentProof.notes || ""),
  };
};

const parseCapacityHp = (value = "") => {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
};

const upsertInstalledCustomerUnit = async ({ task, product, serialUnit, registration }) => {
  const customerId = String(task.customerId || task.payload?.customerId || "").trim();
  const serialNumber = String(serialUnit?.serialNumber || registration?.serialNumber || "").trim();
  if (!customerId || !serialNumber || !registration || registration.status !== "registered") return null;

  const address = task.payload?.customerAddress || {};
  const ampParameters = registration.ampParameters || {};
  const installedAt = parseInstallationDateTime(ampParameters.installationDate, ampParameters.installationTime || "00:00");
  if (!installedAt) throw new Error("The installation record needs a valid date and time before completion.");

  const existingUnit = await Unit.findOne({ serialNumber });
  if (existingUnit?.customer && String(existingUnit.customer) !== customerId) throw new Error("This serial already belongs to another customer. Ask an administrator to review the assignment.");
  const warranty = buildActivatedWarranty(existingUnit?.warranty, installedAt);

  const installedUnit = await Unit.findOneAndUpdate(
    { serialNumber },
    {
      [existingUnit ? "$setOnInsert" : "$set"]: {
        serialNumber,
        qrCode: String(serialUnit?.qrCode || ""),
        qrUnitId: String(serialUnit?.qrUnitId || ""),
        productId: String(product?._id || product?.id || ""),
        modelName: [product?.name, product?.specs].filter(Boolean).join(" ") || product?.sku || "AC Unit",
        brand: String(product?.brand || ""),
        category: String(product?.category || ""),
        capacityHp: parseCapacityHp(product?.specs),
        roomSizeSqm: Number(ampParameters.roomSizeSqm || 0) || null,
        customer: customerId,
        customerName: String(task.customer || ""),
        serviceBranch: String(task.branch || serialUnit?.branch || ""),
        installation: {
          installedAt,
          installedBy: task.assignedTechnicianId || registration.technicianId || undefined,
          addressLine: String(
            address.street || task.address || "",
          ),
          city: String(address.city || ""),
          province: String(address.province || ""),
          zipCode: String(address.postalCode || address.zipCode || "0000"),
          coordinates: {},
        },
        amp: {
          lastCalculatedAt: new Date(),
        },
        warranty,
        status: "active",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  const technicianId = String(task.assignedTechnicianId || registration.technicianId || "").trim();
  let installationHistory = null;
  if (mongoose.Types.ObjectId.isValid(technicianId)) {
    installationHistory = await ServiceHistory.findOne({
      unit: installedUnit._id,
      visitType: "installation",
    });
    if (!installationHistory) {
      installationHistory = await ServiceHistory.findOneAndUpdate({ unit: installedUnit._id, sourceTaskId: String(task._id) }, { $setOnInsert: {
        unit: installedUnit._id,
        sourceTaskId: String(task._id),
        technician: technicianId,
        serviceDate: installedAt,
        visitType: "installation",
        serviceType: "installation",
        conditionRating: "good",
        findings: "Installation completed and assigned AC unit registration verified.",
        actionTaken: "Installed AC unit and verified its assigned QR serial.",
        serviceActions: ["Installed AC unit", "Verified assigned QR serial"],
        technicianInputs: {
          notes: String(registration.ampParameters?.notes || "Installation completed and unit registration verified."),
        },
      } }, { upsert: true, returnDocument: "after", runValidators: true });
    }
  }
  const recommendation = await calculateMaintenanceRecommendation(installedUnit._id);
  if (installationHistory) {
    installationHistory.ampSnapshot = {
      bestServicedBy: recommendation.bestServicedBy,
      recommendedService: recommendation.recommendedService,
      recommendationBasis: recommendation.recommendationBasis,
      nextIdealServiceDate: recommendation.bestServicedBy,
      nextIdealServicePeriod: `Suggested servicing date: ${new Date(recommendation.bestServicedBy).toLocaleDateString("en-US")}`,
      calculatedAt: new Date(),
    };
    await installationHistory.save();
  }
  return installedUnit;
};

const ensureInstalledCustomerUnitsForTask = async (task) => {
  const registrations = getAmpRegistrations(task);
  const serialNumbers = getTaskSerialNumbers(task).filter(
    (serial) => registrations[serial]?.status === "registered",
  );
  const installedUnits = [];

  for (const serialNumber of serialNumbers) {
    const { product, serialUnit } = await findProductSerialUnit(serialNumber);
    if (!product || !serialUnit) continue;
    const installed = await upsertInstalledCustomerUnit({
      task,
      product,
      serialUnit,
      registration: registrations[serialNumber],
    });
    if (installed) installedUnits.push(installed);
  }

  return installedUnits;
};

const updateSerialUnitsForOrderWorkflow = async (order, nextWorkflowStatus) => {
  const serialNumbers = (order.items || []).flatMap((item) =>
    [
      ...(Array.isArray(item.serialNumbers) ? item.serialNumbers : []),
      ...(Array.isArray(item.serialUnits)
        ? item.serialUnits.map((unit) => unit?.serialNumber)
        : []),
    ],
  );
  if (serialNumbers.length === 0) return;

  const products = await Product.find({
    "serialUnits.serialNumber": { $in: serialNumbers },
  });
  const now = new Date();

  await Promise.all(
    products.map(async (product) => {
      let changed = false;
      for (const unit of product.serialUnits || []) {
        if (!serialNumbers.includes(unit.serialNumber)) continue;

        if (nextWorkflowStatus === "complete") {
          unit.status = "sold";
          unit.registeredAt = unit.registeredAt || now;
        } else if (nextWorkflowStatus === "cancelled") {
          unit.status = "available";
          unit.assignedOrderId = "";
          unit.assignedOrderCode = "";
          unit.assignedAt = null;
          unit.registeredAt = null;
        } else {
          unit.status = "assigned";
          unit.assignedOrderId = String(order._id || order.id || "");
          unit.assignedOrderCode = order.orderCode;
          unit.assignedAt = unit.assignedAt || now;
        }
        changed = true;
      }

      if (changed) await product.save();
    }),
  );
};

const syncOrderWorkflowForTask = async (task, status) => {
  const normalizedStatus = normalizeStatus(status || task.status);
  const order = await findLinkedOrderForTask(task);
  if (!order) return;
  const trackingStatus = normalizedStatus === "in-progress"
    ? (hasVerifiedTaskCheckIn(task) ? "arrived" : null)
    : normalizedStatus;
  const timestamp = trackingStatus === "arrived"
    ? task.payload?.checkIn?.checkedInAt || new Date()
    : normalizedStatus === "completed" ? task.completedAt || new Date() : new Date();
  if (!["arrived", "installing", "completed"].includes(trackingStatus) || hasVerifiedTaskCheckIn(task)) {
    appendOrderTrackingEvent(order, trackingStatus, timestamp);
  }
  if (task.assignedTechnicianName) order.assignedTechnician = task.assignedTechnicianName;
  if (task.assignedTechnicianId) order.assignedTechnicianId = task.assignedTechnicianId;
  if (task.scheduledDate && task.scheduledDate !== "TBD") order.installationDate = task.scheduledDate;
  if (task.timeSlot && task.timeSlot !== "TBD") order.installationTimeSlot = task.timeSlot;
  if (trackingStatus === "arrived") order.deliveryStatus = "arrived";
  if (trackingStatus === "installing") {
    order.workflowStatus = "to_install";
    order.deliveryStatus = "installing";
    task.payload = { ...(task.payload || {}), orderWorkflowStatus: "to_install", deliveryStatus: "installing" };
    await task.save();
  }
  if (normalizedStatus !== "completed") {
    await order.save();
    if (!["pending", "accepted"].includes(normalizedStatus)) {
      const checkInAt = String(task.payload?.checkIn?.checkedInAt || "");
      const checkedIn = normalizedStatus === "in-progress" && Boolean(checkInAt);
      await notifyOperationalStaff({
        branch: task.branch || order.stockSourceBranch || order.customerBranch || "",
        title: checkedIn ? "Technician checked in" : "Technician status update",
        message: checkedIn
          ? `${task.assignedTechnicianName || "A technician"} checked in for ${order.orderCode || "an order"}.`
          : `${task.assignedTechnicianName || "A technician"} marked ${order.orderCode || "an order"} as ${normalizedStatus.replace(/-/g, " ")}.`,
        type: "technician",
        category: "task",
        targetId: String(task._id || task.id || ""),
        targetType: "task",
        route: "/admin/services/technicians",
        dedupeKey: `task-status:${task._id || task.taskCode}:${normalizedStatus}:${checkedIn ? checkInAt : "status"}`,
      });
    }
    return;
  }
  if (order.workflowStatus === "complete" || order.workflowStatus !== "to_install") {
    await order.save();
    return;
  }

  // Finish the dependent records first. The order is only moved to COMPLETE
  // after the registered AMP data has produced the customer unit record and
  // the assigned inventory serials have been marked sold.
  await ensureInstalledCustomerUnitsForTask(task);
  await updateSerialUnitsForOrderWorkflow(order, "complete");
  order.workflowStatus = "complete";
  order.status = isCodOrder(order) && !hasCodCollection(order) ? "pending" : "paid";
  order.deliveryStatus = "completed";
  order.stockReservationStatus = "consumed";
  if (!order.assignedTechnician && task.assignedTechnicianName) {
    order.assignedTechnician = task.assignedTechnicianName;
  }
  await order.save();
  await notifyOperationalStaff({
    branch: task.branch || order.stockSourceBranch || order.customerBranch || "",
    title: "Installation completed",
    message: `${task.assignedTechnicianName || "A technician"} completed installation for ${order.orderCode || "an order"}.`,
    type: "technician",
    category: "installation",
    targetId: String(order._id || order.id || ""),
    targetType: "order",
    route: "/admin/services/technicians",
    dedupeKey: `installation-complete:${order._id || order.orderCode}`,
  });
  const customerId = String(order.customer || task.customerId || task.payload?.customerId || "").trim();
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    await Notification.create({
      user: customerId,
      type: "order",
      title: "Installation completed",
      message: `Your AC installation for order ${order.orderCode || ""} is complete. Your warranty and active unit record are now available.`,
      route: "/customer/orders",
      targetId: String(order._id || ""),
    });
  }
};

const withoutEmbeddedProofMedia = (value = {}) => {
  const sanitized = value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
  delete sanitized.proof;
  delete sanitized.beforePhotos;
  delete sanitized.afterPhotos;
  delete sanitized.beforePhotoUri;
  delete sanitized.afterPhotoUri;
  return sanitized;
};

const technicianReportPayload = (payload = {}) => Object.fromEntries(Object.entries({
  serviceLogs: payload.serviceLogs,
  serviceType: payload.serviceType,
  beforeCondition: payload.beforeCondition,
  afterCondition: payload.afterCondition,
  conditionRating: payload.conditionRating,
  findings: payload.findings,
  resolution: payload.resolution,
  serviceActions: payload.serviceActions,
  partsUsed: payload.partsUsed,
  laborCost: payload.laborCost,
  partsCost: payload.partsCost,
  additionalCost: payload.additionalCost,
  notes: payload.notes,
  customerAdvice: payload.customerAdvice,
  proofSubmittedAt: payload.proofSubmittedAt,
  proof: payload.proof,
  completionNotes: payload.completionNotes,
  failureReason: payload.failureReason,
  rescheduleReason: payload.rescheduleReason,
  holdReason: payload.holdReason,
  defectReason: payload.defectReason,
}).filter(([, value]) => value !== undefined));

const getServiceCompletionPaymentBlocker = async (task) => {
  const requestId = task.payload?.requestId;
  if (!requestId) return "";
  return servicePaymentBlocker(await ServiceRequest.findById(requestId));
};

const serviceCostFieldsPresent = (payload = {}) => ["serviceLogs", "laborCost", "partsCost"].some((key) => Object.hasOwn(payload, key));

const serviceCostMutationBlocker = async (task, payload = {}) => {
  if (!serviceCostFieldsPresent(payload) || !task.payload?.requestId) return "";
  const request = await ServiceRequest.findById(task.payload.requestId);
  if (!request?.servicePayment?.collectedAt) return "";
  const current = servicePaymentRecord(request, task.payload || {});
  const next = servicePaymentRecord(request, { ...(task.payload || {}), ...payload });
  return current.laborCost !== next.laborCost || current.partsCost !== next.partsCost
    ? "Payment was already collected. Labor or parts costs can no longer be changed on this visit."
    : "";
};

const syncServicePaymentForTask = async (task) => {
  const requestId = String(task.payload?.requestId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(requestId)) return null;
  const request = await ServiceRequest.findById(requestId);
  if (!request || request.payload?.warrantyClaimId || request.servicePayment?.collectedAt) return request;
  const next = servicePaymentRecord(request, task.payload || {});
  const current = servicePaymentSummary(request);
  const changed = current?.baseAmount !== next.baseAmount || current?.laborCost !== next.laborCost || current?.partsCost !== next.partsCost || current?.amount !== next.amount;
  if (!changed) return request;
  next.quoteId = crypto.randomUUID();
  next.quotedAt = new Date();
  request.servicePayment = next;
  await request.save();
  return request;
};

const validateCompletionReport = (task, payload = {}) => {
  const validation = validateTechnicianTaskCompletion({
    task,
    payload,
    serialNumbers: getTaskSerialNumbers(task),
  });
  if (validation.ok) return null;
  return {
    status: 400,
    message: "Complete the required technician service report before closing this work order.",
    errors: validation.errors,
  };
};

const summarizeTaskProof = (proof = {}) => {
  const beforePhotos = Array.isArray(proof.beforePhotos) ? proof.beforePhotos : [];
  const afterPhotos = Array.isArray(proof.afterPhotos) ? proof.afterPhotos : [];
  return {
    submittedAt: proof.submittedAt || null,
    technicianName: proof.technicianName || "",
    customerSignature: proof.customerSignature || null,
    notes: proof.notes || "",
    beforePhotoCount: beforePhotos.filter((photo) => String(photo?.uri || "").trim()).length,
    afterPhotoCount: afterPhotos.filter((photo) => String(photo?.uri || "").trim()).length,
    hasBeforePhotos: beforePhotos.some((photo) => String(photo?.uri || "").trim()),
    hasAfterPhotos: afterPhotos.some((photo) => String(photo?.uri || "").trim()),
  };
};

const taskTrackingStages = {
  "on-the-way": { stage: "out_for_delivery", label: "Out for Delivery", detail: "Technician is on the way" },
  arrived: { stage: "arrived", label: "Arrived", detail: "Technician arrived at the address" },
  installing: { stage: "installation", label: "Installation", detail: "Installation in progress" },
  "in-progress": { stage: "installation", label: "Installation", detail: "Installation in progress" },
  completed: { stage: "completed", label: "Completed", detail: "Installation completed" },
};

const appendOrderTrackingEvent = (order, status, timestamp = new Date()) => {
  const milestone = taskTrackingStages[status];
  if (!order || !milestone) return;
  const timeline = Array.isArray(order.fulfillmentTimeline) ? order.fulfillmentTimeline : [];
  if (timeline.some((event) => String(event?.stage || "") === milestone.stage)) return;
  order.fulfillmentTimeline = [...timeline, { ...milestone, timestamp }];
};

const completeWarrantyClaimForServiceTask = async (task, request) => {
  const claimId = String(task.payload?.warrantyClaimId || request.payload?.warrantyClaimId || "").trim();
  const unitId = String(task.unitId || request.unitId || "").trim();
  if (!claimId || !mongoose.Types.ObjectId.isValid(unitId)) return;
  const unit = await Unit.findById(unitId);
  if (!unit) return;
  const warranty = unit.warranty?.toObject?.() || unit.warranty || {};
  const claims = Array.isArray(warranty.claims) ? warranty.claims : [];
  const index = claims.findIndex((claim) => String(claim?.claimId || "") === claimId);
  if (index < 0 || String(claims[index].status || "") === "service_completed") return;
  claims[index] = { ...claims[index], status: "service_completed", resolvedAt: new Date() };
  warranty.claims = claims;
  warranty.serviceRecords = [
    ...(Array.isArray(warranty.serviceRecords) ? warranty.serviceRecords : []),
    {
      serviceDate: new Date(),
      visitType: "repair",
      summary: String(task.payload?.findings || task.payload?.resolution || task.description || "Warranty service completed"),
      claimId,
    },
  ];
  warranty.status = effectiveWarrantyStatus({ ...warranty, status: "active" });
  warranty.timeline = appendWarrantyEvent(warranty, "Warranty Service Completed", "Approved warranty repair completed by technician.");
  unit.warranty = warranty;
  await unit.save();
};

const recordCompletedServiceHistory = async (task, request) => {
  const existingHistoryId = String(task.payload?.serviceHistoryId || "").trim();
  if (existingHistoryId && await ServiceHistory.exists({ _id: existingHistoryId })) return ServiceHistory.findById(existingHistoryId);
  if (getTaskSerialNumbers(task).length) return;
  const unitId = String(task.unitId || request.unitId || "").trim();
  const technicianId = String(task.assignedTechnicianId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(unitId) || !mongoose.Types.ObjectId.isValid(technicianId)) return;

  const { serviceHistory: history } = await completeServiceForUnit({
    unitId, technicianId, sourceTaskId: task._id,
    payload: { ...task.payload, serviceDate: task.completedAt || new Date(), warrantyClaimId: request.payload?.warrantyClaimId || task.payload?.warrantyClaimId },
  });
  task.payload = { ...(task.payload || {}), serviceHistoryId: String(history._id), updatedAt: new Date().toISOString() };
  await task.save();
  return history;
};

const notifyCustomerOfCompletedService = async (task, request = {}, completedHistory = null) => {
  if (task.payload?.orderId || task.orderId) return;
  const customerId = String(request.customerId || task.customerId || "").trim();
  if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) return;
  const historyId = String(completedHistory?._id || task.payload?.serviceHistoryId || "").trim();
  const history = completedHistory || (mongoose.Types.ObjectId.isValid(historyId)
    ? await ServiceHistory.findById(historyId).select("aiInterpretation").lean()
    : null);
  const interpretation = history?.aiInterpretation;
  const requestId = String(request._id || "").trim();
  const targetId = requestId || String(task._id || task.id || "");
  const alreadyNotified = await Notification.exists({ user: customerId, targetId, title: "Service completed" });
  if (alreadyNotified) return;
  const message = String(interpretation?.customerSummary || "").trim()
    || `Your technician service for ${request.issue || task.issueType || "your AC unit"} has been completed.`;
  const severity = ["critical", "urgent"].includes(interpretation?.severity) ? "critical"
    : ["soon", "monitor"].includes(interpretation?.severity) ? "warning" : "info";
  await Notification.create({
    user: customerId,
    type: "service",
    category: "service",
    severity,
    targetType: requestId ? "service_request" : "task",
    title: "Service completed",
    message,
    route: requestId ? "/customer/service-requests" : "/customer/units",
    targetId,
    dedupeKey: `service-completed-summary:${targetId}:${historyId || task._id}`,
  });
};

const syncServiceRequestForTask = async (task, status) => {
  const normalizedStatus = normalizeStatus(status || task.status);
  const requestId = String(task.payload?.requestId || task.requestId || "").trim();
  if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) return;

  let nextStatus = "";
  if (["pending", "accepted"].includes(normalizedStatus)) nextStatus = "Assigned";
  if (["on-the-way", "arrived", "installing", "in-progress"].includes(normalizedStatus)) nextStatus = "In Progress";
  if (normalizedStatus === "on-hold") nextStatus = "Assigned";
  if (normalizedStatus === "cancelled") nextStatus = "Cancelled";
  if (normalizedStatus === "completed") nextStatus = "Completed";
  if (!nextStatus) return;

  const request = await ServiceRequest.findById(requestId);
  if (!request) return;
  // A completed request must have its service evidence persisted first.
  const completedHistory = nextStatus === "Completed" ? await recordCompletedServiceHistory(task, request) : null;

  const previousStatus = String(request.status || "").trim().toLowerCase();
  const statusChanged = previousStatus !== nextStatus.toLowerCase();
  request.status = nextStatus;
  request.assignedTechnicianId = task.assignedTechnicianId || request.assignedTechnicianId || "";
  request.assignedTechnicianName = task.assignedTechnicianName || request.assignedTechnicianName || "";
  const timeline = Array.isArray(request.payload?.timeline) ? request.payload.timeline : [];
  const checkInAt = String(task.payload?.checkIn?.checkedInAt || "");
  const checkedIn = normalizedStatus === "in-progress" && Boolean(checkInAt);
  const checkInAlreadyLogged = checkedIn && timeline.some(
    (event) =>
      String(event.title || "").trim().toLowerCase() === "technician checked in" &&
      String(event.timestamp || "") === checkInAt,
  );
  const timelineEvents = [];
  if (statusChanged) {
    timelineEvents.push({
      id: `service_timeline_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      title: `Task changed to ${nextStatus}`,
      description: `Technician task updated to ${nextStatus}.`,
      actor: task.assignedTechnicianName || "Technician",
      timestamp: new Date().toISOString(),
    });
  }
  if (checkedIn && !checkInAlreadyLogged) {
    timelineEvents.push({
      id: `service_checkin_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      title: "Technician checked in",
      description: "The technician recorded a verified GPS arrival at the service address.",
      actor: task.assignedTechnicianName || "Technician",
      timestamp: checkInAt,
    });
  }
  request.payload = {
    ...(request.payload || {}),
    linkedTaskId: String(task._id || task.id || ""),
    taskCode: task.taskCode,
    assignedTechnicianId: request.assignedTechnicianId,
    assignedTechnicianName: request.assignedTechnicianName,
    scheduledDate: task.scheduledDate || request.payload?.scheduledDate || "",
    timeSlot: task.timeSlot || request.payload?.timeSlot || "",
    status: nextStatus,
    completedAt:
      nextStatus === "Completed"
        ? request.payload?.completedAt || new Date().toISOString()
        : request.payload?.completedAt || null,
    timeline: [...timeline, ...timelineEvents],
    updatedAt: new Date().toISOString(),
  };

  await request.save();
  await cancelWarrantyForRequest(request, task.payload?.cancellationReason);
  if (!["pending", "accepted"].includes(normalizedStatus) && (statusChanged || (checkedIn && !checkInAlreadyLogged))) {
    await notifyOperationalStaff({
      branch: task.branch || request.branch || "",
      title: checkedIn ? "Technician checked in" : "Technician service update",
      message: checkedIn
        ? `${task.assignedTechnicianName || "A technician"} checked in for ${request.issue || task.title || "a service request"}.`
        : `${task.assignedTechnicianName || "A technician"} marked ${request.issue || task.title || "a service request"} as ${nextStatus}.`,
      type: "technician",
      category: "service",
      targetId: String(task._id || task.id || ""),
      targetType: "task",
      route: "/admin/services/technicians",
      dedupeKey: `service-task-status:${task._id || task.taskCode}:${normalizedStatus}:${checkedIn ? checkInAt : "status"}`,
      roles: ["admin", "superadmin", "manager", "owner"],
    });
  }
  if (nextStatus === "Completed") {
    await completeWarrantyClaimForServiceTask(task, request);
    await notifyCustomerOfCompletedService(task, request, completedHistory);
  }
};

const reconcileCompletedTask = async (task) => {
  await syncOrderWorkflowForTask(task, "completed");
  await syncServiceRequestForTask(task, "completed");
  if (!String(task.payload?.requestId || task.requestId || "").trim()) {
    const completedHistory = await recordCompletedServiceHistory(task, {});
    await notifyCustomerOfCompletedService(task, {}, completedHistory);
  }
};

const buildRegistrationRecord = ({ req, task, serialNumber, payload, status }) => {
  const installationDate = String(payload.installationDate || formatDateKeyInTimeZone(new Date()));
  const installationTime = String(payload.installationTime || "00:00");
  const ampParameters = {
    installationDate,
    installationTime,
    installationTimestamp: parseInstallationDateTime(installationDate, installationTime).toISOString(),
    roomSizeSqm: Number(payload.roomSizeSqm || 0) || null,
    conditionRating: String(payload.conditionRating || "good"),
    notes: String(payload.notes || ""),
  };

  return {
    serialNumber,
    status,
    taskId: String(task._id || task.id || ""),
    taskCode: task.taskCode,
    technicianId: String(req.authUser._id || ""),
    technicianName: req.authUser.name || `${req.authUser.name_first || ""} ${req.authUser.name_last || ""}`.trim() || "Technician",
    submittedAt: new Date().toISOString(),
    ampParameters,
    installationProof: {
      roomSizeSqm: ampParameters.roomSizeSqm,
      conditionRating: ampParameters.conditionRating,
      notes: ampParameters.notes,
      recordedAt: new Date().toISOString(),
    },
    defectReason: String(payload.defectReason || ""),
    ampServicePlan: null,
  };
};

const isBranchNearby = (taskBranch = "", techBranch = "") => {
  const branch = String(taskBranch || "").trim();
  const technicianBranch = String(techBranch || "").trim();
  if (!branch || !technicianBranch) return false;
  if (branch === technicianBranch) return true;
  const order = BRANCH_PRIORITY[branch] || [];
  const index = order.indexOf(technicianBranch);
  return index >= 0 && index <= 2;
};

const canTechnicianAcceptTask = (task, technician) => {
  if (!task || !technician) return false;
  const assignedTechId = String(task.assignedTechnicianId || "");
  const currentTechId = String(technician._id || "");
  if (assignedTechId && assignedTechId !== currentTechId) return false;
  const taskBranch = String(task.branch || "").trim();
  if (!taskBranch) return true;
  if (taskBranch === String(technician.assignedBranch || "").trim()) return true;
  if (taskBranch === String(technician.activeBranch || "").trim()) return true;
  return isBranchNearby(task.branch, technician.assignedBranch) || isBranchNearby(task.branch, technician.activeBranch);
};

const hydrateTaskResponse = (task, { includeProofMedia = true } = {}) => {
  const payload = task.payload && Object.keys(task.payload).length
    ? withoutEmbeddedProofMedia(task.payload)
    : null;
  const progress = getRegistrationProgress(task);
  const base = typeof task.toJSON === "function"
    ? task.toJSON()
    : { ...task, id: String(task.id || task._id || "") };
  delete base._id;
  delete base.__v;
  const proof = includeProofMedia ? (task.proof || {}) : summarizeTaskProof(task.proof || {});
  if (base.payload) base.payload = payload || {};
  if (!payload) {
    return {
      ...base,
      ...serviceCosts(base),
      proof,
      registrationProgress: progress,
    };
  }

  return {
    // Preserve the canonical Task fields (address, schedule, unit and
    // customer metadata) while keeping the order payload such as items and
    // serial numbers. Previously the payload replaced the task and left the
    // technician Work Details screen without the information it needs.
    ...base,
    ...payload,
    ...serviceCosts({ ...base, ...payload }),
    id: base.id,
    taskCode: task.taskCode,
    title: task.title,
    customer: task.customer,
    customerName: payload.customerName || task.customer,
    customerId: payload.customerId || task.customerId || "",
    customerPhone: payload.customerPhone || task.customerPhone || "",
    address: task.address,
    unitId: payload.unitId || task.unitId || "",
    unitName: payload.unitName || task.unitName || "",
    unitType: payload.unitType || task.unitType || "",
    issueType: payload.issueType || task.issueType || "",
    description: payload.description || task.description || "",
    scheduledDate: payload.scheduledDate || task.scheduledDate || "",
    timeSlot: payload.timeSlot || task.timeSlot || "",
    priority: task.priority,
    assignedTechnicianId: task.assignedTechnicianId,
    assignedTechnicianName: task.assignedTechnicianName,
    proof,
    registrationProgress: progress,
    status: task.status,
    createdAt: payload.createdAt || task.createdAt,
    updatedAt: payload.updatedAt || task.updatedAt,
  };
};

const getTaskUnitSummary = async (task) => {
  const unitId = String(task?.unitId || task?.payload?.unitId || "").trim();
  if (!unitId) return null;
  const unit = mongoose.Types.ObjectId.isValid(unitId)
    ? await Unit.findById(unitId).lean()
    : await Unit.findOne({ $or: [{ serialNumber: unitId }, { qrUnitId: unitId }, { qrCode: unitId }] }).lean();
  if (!unit) return null;
  const warranty = unit.warranty || {};
  return {
    id: String(unit._id),
    unitName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || task.unitName || "AC unit",
    brand: unit.brand || "",
    model: unit.modelName || "",
    modelName: unit.modelName || "",
    serialNumber: unit.serialNumber || "",
    capacityHp: Number(unit.capacityHp || 0),
    roomSizeSqm: unit.roomSizeSqm ?? null,
    installationDate: unit.installation?.installedAt || null,
    installationAddress: unit.installation?.addressLine || "",
    warrantyStatus: effectiveWarrantyStatus(warranty),
    warrantyExpirationDate: warranty.expirationDate || null,
    warrantyCoverage: getWarrantyCoverage(warranty),
    bestServicedBy: unit.amp?.bestServicedBy || null,
    recommendedService: unit.amp?.recommendedService || "",
    serviceBranch: unit.serviceBranch || "",
    status: unit.status || "",
  };
};

const listTasks = async (req, res) => {
  try {
    const role = req.authUser.role;
    const technicianId = String(req.query?.technician_id || "").trim();
    const scopeQuery = branchScopeQuery(req);
    let query = { ...scopeQuery };

    if (role === "customer") {
      query = buildCustomerTaskScopeQuery(req.authUser);
    } else if (role === "technician") {
      query = {
        $and: [
          scopeQuery,
          {
            $or: [
              { assignedTechnicianId: String(req.authUser._id || "") },
              { "schedule.teamMemberIds": String(req.authUser._id || "") },
            ],
          },
        ],
      };
    } else if (technicianId) {
      query.assignedTechnicianId = technicianId;
    }

    const scheduledDate = String(req.query?.scheduled_date || req.query?.scheduledDate || "").trim();
    if (scheduledDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) return res.status(400).json({ message: "Use a valid schedule date in YYYY-MM-DD format." });
      query = { $and: [query, { scheduledDate }] };
    }
    const requestedBranch = String(req.query?.branch || "").trim();
    if (requestedBranch && role === "superadmin") query = { $and: [query, { branch: requestedBranch }] };

    const requestedLimit = Number(req.query?.limit);
    const defaultLimit = ["customer", "technician"].includes(role) ? 100 : 200;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200)
      : defaultLimit;
    // List screens do not display embedded camera/signature media. Excluding
    // it in MongoDB (rather than after retrieval) prevents old base64 proof
    // records from making /api/tasks exceed Vercel's 30-second response limit.
    const tasks = await Task.find(query)
      .select([
        "-proof.beforePhotos",
        "-proof.afterPhotos",
        "-proof.customerSignature.signature",
        "-payload.proof",
        "-payload.beforePhotos",
        "-payload.afterPhotos",
        "-payload.beforePhotoUri",
        "-payload.afterPhotoUri",
        "-payload.customerSignature",
        "-payload.signature",
      ].join(" "))
      .sort(scheduledDate ? { branch: 1, timeSlot: 1, updatedAt: -1 } : { updatedAt: -1 })
      .limit(limit)
      .lean();
    if (["technician", "admin", "superadmin"].includes(role)) return res.json({ tasks: await hydrateOperationalTaskList(tasks) });
    return res.json({ tasks: tasks.map((task) => { const hydrated = hydrateTaskResponse(task, { includeProofMedia: false }); delete hydrated.schedule; return hydrated; }) });
  } catch (error) {
    console.error("Failed to list tasks:", error);
    return res.status(500).json({ message: "Unable to fetch tasks right now." });
  }
};

const resolveTaskTechnician = async (id, branch) => {
  if (!id) return null;
  const technician = mongoose.Types.ObjectId.isValid(id) ? await User.findById(id) : null;
  if (!technician || technician.role !== "technician" || technician.isDeleted || ["disabled", "deleted"].includes(technician.accountStatus)) {
    const error = new Error("Choose an active technician account."); error.status = 400; throw error;
  }
  const assignedBranch = technician.activeBranch || technician.assignedBranch;
  if (branch && assignedBranch !== branch) { const error = new Error("Choose a technician assigned to this work order's branch."); error.status = 409; throw error; }
  return technician;
};
const resolveTaskTeam = async (ids = [], branch = "", primaryTechnicianId = "") => {
  const uniqueIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || "").trim()).filter((value) => value && value !== String(primaryTechnicianId || ""))));
  if (!uniqueIds.length) return [];
  if (uniqueIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) { const error = new Error("Choose valid active technicians for the support team."); error.status = 400; throw error; }
  const users = await User.find({ _id: { $in: uniqueIds } });
  const byId = new Map(users.map((user) => [String(user._id), user]));
  return uniqueIds.map((id) => {
    const technician = byId.get(id);
    if (!technician || technician.role !== "technician" || technician.isDeleted || ["disabled", "deleted"].includes(technician.accountStatus)) { const error = new Error("Choose active technician accounts for the support team."); error.status = 400; throw error; }
    const assignedBranch = technician.activeBranch || technician.assignedBranch || "";
    if (branch && assignedBranch !== branch) { const error = new Error("Every support-team member must belong to this work order's branch."); error.status = 409; throw error; }
    return { id: String(technician._id), name: getTechnicianDisplayName(technician) };
  });
};
const notifyTaskAssignment = async (task) => {
  if (!task.assignedTechnicianId) return;
  await createDedupedNotification({ user: task.assignedTechnicianId, type: "technician", category: "task", title: "Work order assigned", message: `${task.title} is assigned to you. Open My Work for details.`, targetId: String(task._id), targetType: "task", route: "/technician/tasks", dedupeKey: `work-assignment:${task._id}:${task.assignedTechnicianId}` });
  await notifyOperationalStaff({ branch: task.branch, type: "technician", category: "task", title: "Work order assigned", message: `${task.title} is assigned to ${task.assignedTechnicianName}.`, targetId: String(task._id), targetType: "task", route: "/admin/services/technicians", dedupeKey: `work-assignment:${task._id}:${task.assignedTechnicianId}` });
};
const notifyTaskScheduleUpdate = async (task) => {
  const recipients = Array.from(new Set([String(task.assignedTechnicianId || "").trim(), ...(task.schedule?.teamMemberIds || []).map((value) => String(value || "").trim())].filter(Boolean)));
  const scheduleKey = crypto.createHash("sha256").update(JSON.stringify({ scheduledDate: task.scheduledDate, timeSlot: task.timeSlot, assignedTechnicianId: task.assignedTechnicianId, schedule: task.schedule || {} })).digest("hex").slice(0, 16);
  await Promise.all(recipients.map((userId) => createDedupedNotification({ user: userId, type: "technician", category: "task", title: "Work schedule updated", message: `${task.taskCode} is scheduled for ${task.scheduledDate} · ${task.timeSlot}. Open My Work for current details.`, targetId: String(task._id), targetType: "task", route: "/technician/tasks", dedupeKey: `work-schedule:${task._id}:${userId}:${scheduleKey}` })));
};

const hydrateOperationalTaskList = async (tasks = []) => {
  const orderIds = [], orderCodes = [], requestIds = [];
  tasks.forEach((task) => { const payload = task.payload || {}; const orderId = String(payload.orderId || task.orderId || "").trim(); const orderCode = String(payload.orderCode || task.orderCode || "").trim(); const requestId = String(payload.requestId || task.requestId || "").trim(); if (mongoose.Types.ObjectId.isValid(orderId)) orderIds.push(orderId); if (orderCode) orderCodes.push(orderCode); if (mongoose.Types.ObjectId.isValid(requestId)) requestIds.push(requestId); });
  const orderConditions = []; if (orderIds.length) orderConditions.push({ _id: { $in: orderIds } }); if (orderCodes.length) orderConditions.push({ orderCode: { $in: orderCodes } });
  const [orders, requests] = await Promise.all([orderConditions.length ? Order.find({ $or: orderConditions }).select("orderCode items paymentMethod paymentStatus totalAmount").lean() : [], requestIds.length ? ServiceRequest.find({ _id: { $in: requestIds } }).select("servicePayment issueType payload").lean() : []]);
  const ordersById = new Map(orders.map((order) => [String(order._id), order])); const ordersByCode = new Map(orders.map((order) => [String(order.orderCode), order])); const requestsById = new Map(requests.map((request) => [String(request._id), request]));
  return tasks.map((task) => { const payload = task.payload || {}; const order = ordersById.get(String(payload.orderId || task.orderId || "")) || ordersByCode.get(String(payload.orderCode || task.orderCode || "")) || null; const request = requestsById.get(String(payload.requestId || task.requestId || "")) || null; return { ...hydrateTaskResponse(task, { includeProofMedia: false }), scheduleDetails: buildTaskScheduleDetails(task, { order, serviceRequest: request }) }; });
};

const createTask = async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const payload = req.body || {};
    const nowIso = new Date().toISOString();
    const taskCode = String(payload.taskCode || `TSK-${Date.now()}`).trim();
    const title = String(payload.title || payload.issueType || "Service Task").trim();
    const customerName = String(payload.customerName || payload.customer || "Customer").trim();
    const address = String(payload.address || "TBD").trim();
    if (["completed", "cancelled"].includes(normalizeStatus(payload.status))) return res.status(400).json({ message: "Create the work order first, then complete it through the verified technician workflow." });
    const taskBranch = req.authUser.role === "superadmin" ? String(payload.branch || "") : req.activeBranch;
    const technician = await resolveTaskTechnician(String(payload.assignedTechnicianId || ""), taskBranch);
    const team = await resolveTaskTeam(payload.schedule?.teamMemberIds, taskBranch, payload.assignedTechnicianId);

    const task = await Task.create({
      taskCode,
      title,
      customer: customerName || "Customer",
      address,
      customerId: String(payload.customerId || payload.userId || ""),
      customerEmail: String(payload.customerEmail || ""),
      customerPhone: String(payload.customerPhone || ""),
      unitId: String(payload.unitId || ""),
      unitName: String(payload.unitName || ""),
      unitType: String(payload.unitType || ""),
      issueType: String(payload.issueType || ""),
      description: String(payload.description || payload.concern || ""),
      assignedTechnicianId: String(payload.assignedTechnicianId || ""),
      assignedTechnicianName: technician ? getTechnicianDisplayName(technician) : "",
      status: normalizeStatus(payload.status),
      priority: String(payload.priority || "medium").toLowerCase(),
      scheduledDate: String(payload.scheduledDate || payload.preferredDate || "TBD"),
      timeSlot: String(payload.timeSlot || payload.preferredSchedule || "TBD"),
      assignedRole: String(payload.assignedRole || "technician"),
      branch: taskBranch || technician?.activeBranch || technician?.assignedBranch || "",
      schedule: normalizeTaskSchedule(payload.schedule, team),
      completedAt: normalizeStatus(payload.status) === "completed" ? new Date() : null,
      payload: { ...payload, createdAt: payload.createdAt || nowIso, updatedAt: payload.updatedAt || nowIso },
    });

    await notifyTaskAssignment(task);
    if (team.length) await notifyTaskScheduleUpdate(task);
    return res.status(201).json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to create task:", error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to create task right now." });
  }
};

const updateTask = async (req, res) => {
  try {
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const payload = req.body || {};
    const requestedStatus = parseTaskStatus(payload.status);
    const costError = validateServiceCosts(payload);
    if (costError) return res.status(400).json({ message: costError });
    const costMutationError = await serviceCostMutationBlocker(task, payload);
    if (costMutationError) return res.status(409).json({ message: costMutationError });
    if (normalizeStatus(task.status) === "completed" && requestedStatus === "completed") {
      await reconcileCompletedTask(task);
      return res.json({ task: hydrateTaskResponse(task), replayed: true });
    }

    const mutationBlocker = awaitingVisitFollowUp(task) ? FOLLOW_UP_REQUIRED : getTaskMutationBlocker(task.status);
    if (mutationBlocker) {
      return res.status(409).json({ message: mutationBlocker });
    }

    const reassigned = req.authUser.role !== "technician" && payload.assignedTechnicianId && String(payload.assignedTechnicianId) !== String(task.assignedTechnicianId);
    if (reassigned) {
      const technician = await resolveTaskTechnician(String(payload.assignedTechnicianId), task.branch);
      payload.assignedTechnicianName = getTechnicianDisplayName(technician);
      // The incoming technician must record their own arrival and service proof.
      task.proof = {};
      task.payload = { ...(task.payload || {}) };
      for (const field of ["checkIn", "arrivalValidation", "installationStartedAt", "proof", "serviceLogs", "findings", "resolution", "serviceActions", "serviceHistoryId", "laborCost", "partsCost", "additionalCost"]) { delete task.payload[field]; delete payload[field]; }
    }
    let normalizedSchedule = null;
    if (req.authUser.role !== "technician" && payload.schedule && typeof payload.schedule === "object") {
      const primaryTechnicianId = String(payload.assignedTechnicianId || task.assignedTechnicianId || "");
      const team = await resolveTaskTeam(payload.schedule.teamMemberIds, task.branch, primaryTechnicianId);
      normalizedSchedule = normalizeTaskSchedule(payload.schedule, team);
    }

    if (req.authUser.role === "technician") {
      const currentTechId = String(req.authUser._id || "");
      if (!task.assignedTechnicianId || String(task.assignedTechnicianId) !== currentTechId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (normalizeStatus(task.status) === "pending") {
        return res.status(409).json({ message: "This work order must be activated by an administrator before work can begin." });
      }
    }

    const nextStatus = normalizeStatus(payload.status || task.status);
    if (["arrived", "installing"].includes(nextStatus) && !hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "The assigned technician must check in with GPS before arrival or installation can be confirmed." });
    }
    const proof = buildTaskProof({ task, payload, req, nextStatus });
    const currentStatus = normalizeStatus(task.status);
    if (
      req.authUser.role === "technician" &&
      nextStatus !== currentStatus &&
      !["completed", "on-hold", "failed", "rescheduled"].includes(nextStatus)
    ) {
      return res.status(409).json({ message: "Admin controls work-order activation. Technicians can complete, hold, fail, or request rescheduling only after activation." });
    }
    const lifecycleOrder = ["pending", "accepted", "on-the-way", "arrived", "installing", "completed"];
    const currentIndex = lifecycleOrder.indexOf(currentStatus);
    const nextIndex = lifecycleOrder.indexOf(nextStatus);
    if (req.authUser.role === "technician" && nextStatus !== "failed" && nextStatus !== "rescheduled" && nextStatus !== "on-hold" && currentIndex >= 0 && nextIndex >= 0 && nextIndex > currentIndex + 1) {
      return res.status(409).json({ message: `Move this work order through ${lifecycleOrder[currentIndex + 1]} before marking it ${nextStatus}.` });
    }
    if (req.authUser.role === "technician" && ["installing", "completed"].includes(nextStatus) && !["arrived", "installing", "in-progress"].includes(currentStatus)) {
      return res.status(409).json({ message: "Check in at the customer location before starting installation." });
    }
    if (req.authUser.role === "technician" && nextStatus === "completed" && !hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "Record a verified GPS check-in at the customer location before completing this work order." });
    }
    if (req.authUser.role === "technician" && nextStatus === "completed") {
      const arrivalBlocker = installationArrivalBlocker(task);
      if (arrivalBlocker) return res.status(409).json({ message: arrivalBlocker });
    }
    const technicianPayload = req.authUser.role === "technician"
      ? technicianReportPayload(payload)
      : payload;
    const updatedPayload = {
      ...withoutEmbeddedProofMedia(task.payload),
      ...withoutEmbeddedProofMedia(technicianPayload),
      status: payload.status || task.status,
      updatedAt: new Date().toISOString(),
    };
    if (nextStatus === "on-the-way" && !updatedPayload.onTheWayAt) {
      updatedPayload.onTheWayAt = new Date().toISOString();
    }
    if (nextStatus === "installing" && hasVerifiedTaskCheckIn(task) && !updatedPayload.installationStartedAt) {
      updatedPayload.installationStartedAt = new Date().toISOString();
    }

    if (req.authUser.role !== "technician") {
      task.title = String(payload.title || task.title || "Service Task").trim();
      task.customer = String(payload.customerName || payload.customer || task.customer || "Customer").trim();
      task.address = String(payload.address || task.address || "TBD").trim();
      task.customerId = String(payload.customerId || payload.userId || task.customerId || "");
      task.customerEmail = String(payload.customerEmail || task.customerEmail || "");
      task.customerPhone = String(payload.customerPhone || task.customerPhone || "");
      task.unitId = String(payload.unitId || task.unitId || "");
      task.unitName = String(payload.unitName || task.unitName || "");
      task.unitType = String(payload.unitType || task.unitType || "");
      task.issueType = String(payload.issueType || task.issueType || "");
      task.description = String(payload.description || payload.concern || task.description || "");
      task.assignedTechnicianId = String(payload.assignedTechnicianId || task.assignedTechnicianId || "");
      task.assignedTechnicianName = String(payload.assignedTechnicianName || task.assignedTechnicianName || "");
      task.priority = String(payload.priority || task.priority || "medium").toLowerCase();
      task.scheduledDate = String(payload.scheduledDate || payload.preferredDate || task.scheduledDate || "TBD");
      task.timeSlot = String(payload.timeSlot || payload.preferredSchedule || task.timeSlot || "TBD");
      if (normalizedSchedule) task.schedule = normalizedSchedule;
    }
    task.status = nextStatus;
    if (nextStatus === "completed") {
      const servicePaymentError = await getServiceCompletionPaymentBlocker(task);
      if (servicePaymentError) return res.status(409).json({ message: servicePaymentError });
      const reportError = validateCompletionReport(task, payload);
      if (reportError) {
        return res.status(reportError.status).json({ message: reportError.message, errors: reportError.errors });
      }
      const completionError = assertCanCompleteTask(task);
      if (completionError) {
        return res.status(completionError.status).json({
          message: completionError.message,
          registrationProgress: completionError.progress,
        });
      }
      const proofError = assertInstallationProof(task, proof, payload);
      if (proofError) {
        return res.status(proofError.status).json({ message: proofError.message });
      }
      const orderCompletionBlocker = await getOrderCompletionBlocker(task);
      if (orderCompletionBlocker) {
        return res.status(409).json({ message: orderCompletionBlocker });
      }
    }
    task.completedAt = nextStatus === "completed" ? new Date() : null;
    task.proof = proof;
    task.payload = updatedPayload;

    await task.save();
    await syncServicePaymentForTask(task);
    if (reassigned) await notifyTaskAssignment(task);
    if (normalizedSchedule || payload.scheduledDate || payload.timeSlot) await notifyTaskScheduleUpdate(task);
    await syncOrderWorkflowForTask(task, nextStatus);
    await syncServiceRequestForTask(task, nextStatus);
    if (nextStatus === "completed" && !String(task.payload?.requestId || task.requestId || "").trim()) {
      const completedHistory = await recordCompletedServiceHistory(task, {});
      await notifyCustomerOfCompletedService(task, {}, completedHistory);
    }
    return res.json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to update task:", error);
    return res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to update task right now." });
  }
};

const getTaskById = async (req, res) => {
  try {
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    const unit = await getTaskUnitSummary(task);
    const order = await findLinkedOrderForTask(task);
    const codPayment = order && isCodOrder(order) ? { amount: order.totalAmount, collectedAt: order.codCollection?.collectedAt || null } : null;
    const orderPayment = order ? buildOrderPaymentSnapshot(order) : null;
    const serviceRequest = task.payload?.requestId ? await ServiceRequest.findById(task.payload.requestId) : null;
    return res.json({ task: {
      ...hydrateTaskResponse(task),
      unit,
      codPayment,
      orderPayment,
      servicePayment: servicePaymentSummary(serviceRequest),
      scheduleDetails: buildTaskScheduleDetails(task, { order, serviceRequest }),
      technicianAccessRole: req.authUser.role === "technician"
        && String(task.assignedTechnicianId || "") !== String(req.authUser._id || "")
        ? "support"
        : "primary",
    } });
  } catch (error) {
    console.error("Failed to fetch task:", error);
    return res.status(500).json({ message: "Unable to fetch task right now." });
  }
};

const acceptTask = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") {
      return res.status(403).json({ message: "Forbidden" });
    }

    return res.status(409).json({ message: "Work orders are activated by an administrator when the linked order is dispatched." });
  } catch (error) {
    console.error("Failed to accept task:", error);
    return res.status(500).json({ message: "Unable to accept task right now." });
  }
};

const confirmCodCollection = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") return res.status(403).json({ message: "Forbidden" });
    if (req.body?.confirmed !== true) return res.status(400).json({ message: "Confirm that you received the full cash payment." });
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) return res.status(404).json({ message: "Task not found" });
    const order = await findLinkedOrderForTask(task);
    const technicianId = String(req.authUser._id);
    const blocker = codCollectionBlocker(order, task, technicianId);
    if (blocker) return res.status(409).json({ message: blocker });
    if (!hasVerifiedTaskCheckIn(task)) return res.status(409).json({ message: "A verified GPS check-in is required." });
    const collectedAt = order.codCollection?.collectedAt || new Date();
    // Conditional write makes retries safe and preserves the original collector.
    await Order.updateOne({
      _id: order._id, assignedTechnicianId: technicianId, workflowStatus: "to_install",
      "codCollection.collectedAt": null,
    }, { $set: {
      codCollection: { collectedAt, technicianId, taskId: String(task._id), amount: order.totalAmount },
      paymentStatus: "paid", status: "paid",
      "receipt.paymentStatus": "paid", "receipt.amountPaid": order.totalAmount,
      "receipt.paymentReference": "COD-" + order.orderCode,
    } });
    const saved = await findLinkedOrderForTask(task);
    if (!hasCodCollection(saved)) return res.status(409).json({ message: "Order changed. Refresh this work order before confirming payment." });
    await notifyOperationalStaff({
      branch: order.stockSourceBranch || order.customerBranch || "",
      title: "COD payment collected", message: "The assigned technician confirmed cash collection for " + order.orderCode + ".",
      type: "payment", category: "orderUpdates", targetType: "order", targetId: String(order._id),
      dedupeKey: "cod-collected:" + order._id,
    });
    return res.json({ task: { ...hydrateTaskResponse(task), codPayment: { amount: saved.totalAmount, collectedAt: saved.codCollection.collectedAt } } });
  } catch (error) {
    console.error("Failed to confirm COD collection:", error);
    return res.status(500).json({ message: "Unable to confirm cash collection. Refresh and try again." });
  }
};

const checkInTask = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) return res.status(404).json({ message: "Task not found" });

    const technicianId = String(req.authUser._id || "");
    if (!task.assignedTechnicianId || String(task.assignedTechnicianId) !== technicianId) {
      return res.status(403).json({ message: "This task is assigned to another technician." });
    }
    if (normalizeStatus(task.status) !== "in-progress") {
      return res.status(409).json({ message: "This work order must be activated by an administrator before checking in." });
    }
    if (hasVerifiedTaskCheckIn(task)) {
      return res.json({ task: hydrateTaskResponse(task), checkIn: task.payload.checkIn });
    }

    const coordinates = req.body?.coordinates || req.body?.location?.coordinates || {};
    if (coordinates.latitude === null || coordinates.longitude === null || coordinates.latitude === "" || coordinates.longitude === "") return res.status(400).json({ message: "A valid GPS location is required to check in." });
    const latitude = Number(coordinates.latitude);
    const longitude = Number(coordinates.longitude);
    const accuracy = Number(coordinates.accuracy || 0);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ message: "A valid GPS location is required to check in." });
    }

    const now = new Date().toISOString();
    task.status = "in-progress";
    task.payload = {
      ...(task.payload || {}),
      checkIn: { latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : 0, checkedInAt: now },
      arrivalValidation: null,
      installationStartedAt: null,
      status: "in-progress",
      updatedAt: now,
    };
    await task.save();
    await syncOrderWorkflowForTask(task, "in-progress");
    await syncServiceRequestForTask(task, "in-progress");
    return res.json({ task: hydrateTaskResponse(task), checkIn: task.payload.checkIn });
  } catch (error) {
    console.error("Failed to check in technician task:", error);
    return res.status(500).json({ message: "Unable to check in to this work order right now." });
  }
};

const confirmInstallationArrival = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") return res.status(403).json({ message: "Forbidden" });
    if (req.body?.customerPresent !== true) {
      return res.status(400).json({ message: "If nobody is present, submit Failed to Install with a proof photo." });
    }
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (!isOrderInstallationTask(task)) return res.status(409).json({ message: "Customer-presence validation applies only to installation work orders." });
    if (normalizeStatus(task.status) !== "in-progress" || !hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "Record a verified GPS check-in before confirming customer presence." });
    }
    const technicianId = String(req.authUser._id || "");
    if (String(task.assignedTechnicianId || "") !== technicianId) return res.status(403).json({ message: "This task is assigned to another technician." });
    const checkedInAt = task.payload.checkIn.checkedInAt;
    const validatedAt = new Date().toISOString();
    task.status = "installing";
    task.payload = {
      ...(task.payload || {}),
      status: "installing",
      arrivalValidation: { customerPresent: true, checkedInAt, validatedAt, technicianId },
      installationStartedAt: task.payload?.installationStartedAt || validatedAt,
      updatedAt: validatedAt,
    };
    await task.save();
    await syncOrderWorkflowForTask(task, "installing");
    return res.json({ task: hydrateTaskResponse(task), arrivalValidation: task.payload.arrivalValidation });
  } catch (error) {
    console.error("Failed to validate installation arrival:", error);
    return res.status(500).json({ message: "Unable to confirm customer presence right now." });
  }
};

const getRegistrationContextBySerial = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const serialNumber = String(req.params.serialNumber || "").trim();
    if (!serialNumber) {
      return res.status(400).json({ message: "Serial number is required." });
    }

    const { product, serialUnit } = await findProductSerialUnit(serialNumber);
    const resolvedSerial = String(serialUnit?.serialNumber || serialNumber).trim();
    const scopeQuery = branchScopeQuery(req);
    const techId = String(req.authUser._id || "");
    const task = await Task.findOne({
      $and: [
        scopeQuery,
        {
          $or: [
            { assignedTechnicianId: techId },
          ],
        },
        {
          $or: [
            { "payload.serialNumbers": resolvedSerial },
            { "payload.items.serialNumbers": resolvedSerial },
            { "payload.items.serialUnits.serialNumber": resolvedSerial },
          ],
        },
      ],
    }).sort({ updatedAt: -1 });

    if (!task && !serialUnit) {
      return res.status(404).json({ message: "No assigned task or AC unit was found for this QR label." });
    }

    return res.json({
      task: task ? hydrateTaskResponse(task) : null,
      unit: serialUnit
        ? {
            serialNumber: serialUnit.serialNumber,
            qrUnitId: serialUnit.qrUnitId || "",
            productId: String(product._id || ""),
            productName: product.name,
            productSku: product.sku,
            brand: product.brand || "",
            model: [product.specs, product.sku].filter(Boolean).join(" / "),
            status: serialUnit.status || "available",
            branch: serialUnit.branch || "",
            ampRegistration: serialUnit.ampRegistration || null,
            defectHold: serialUnit.defectHold || null,
          }
          : { serialNumber: resolvedSerial },
    });
  } catch (error) {
    console.error("Failed to load registration context:", error);
    return res.status(500).json({ message: "Unable to load QR registration context right now." });
  }
};

const technicianName = (value) =>
  value?.name || `${value?.name_first || ""} ${value?.name_last || ""}`.trim() || "Technician";

const containsSerial = (task, serialNumber) => getTaskSerialNumbers(task)
  .some((serial) => String(serial).toLowerCase() === String(serialNumber).toLowerCase());

const getTechnicianUnitHistoryBySerial = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const serialNumber = String(req.params.serialNumber || "").trim();
    if (!serialNumber) return res.status(400).json({ message: "Serial number is required." });

    // Unit history is only available while servicing an AC unit that belongs
    // to the technician's own work order. A QR label must never become a way
    // to browse another customer's equipment history.
    const taskId = String(req.query?.taskId || "").trim();
    if (!taskId) {
      return res.status(400).json({ message: "Open this AC unit from an assigned work order first." });
    }
    const task = await findTaskForRequest(taskId, req);
    if (!task) return res.status(404).json({ message: "Work order not found." });
    if (String(task.assignedTechnicianId || "") !== String(req.authUser._id || "")) {
      return res.status(403).json({ message: "This work order is assigned to another technician." });
    }
    const assignedUnitId = String(task.unitId || task.payload?.unitId || "");
    const assignedUnit = mongoose.Types.ObjectId.isValid(assignedUnitId)
      ? await Unit.findById(assignedUnitId).select("serialNumber").lean() : null;
    const matchesAssignedUnit = assignedUnit && String(assignedUnit.serialNumber).toLowerCase() === serialNumber.toLowerCase();
    if (!containsSerial(task, serialNumber) && !matchesAssignedUnit) {
      return res.status(403).json({ message: "This AC unit is not assigned to the selected work order." });
    }

    const unit = await Unit.findOne({ serialNumber: new RegExp(`^${serialNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (!unit) return res.status(404).json({ message: "No installed AC unit was found for this QR label." });

    const { product, serialUnit } = await findProductSerialUnit(unit.serialNumber);
    const requestId = String(task.payload?.requestId || task.requestId || "").trim();
    const serviceRequest = mongoose.Types.ObjectId.isValid(requestId)
      ? await ServiceRequest.findById(requestId).select("branch unitId assignedTechnicianId").lean()
      : null;
    if (serviceRequest?.unitId && String(serviceRequest.unitId) !== String(unit._id)) {
      return res.status(409).json({ message: "The service request is linked to a different AC unit. Ask an administrator to correct the booking." });
    }
    const routedBranch = await resolvePreferredBranch({
      city: unit.installation?.city,
      province: unit.installation?.province,
    });
    const branchContext = resolveServiceVisitBranch({
      requestBranch: serviceRequest?.branch,
      taskBranch: task.branch || task.payload?.branch,
      unitBranch: unit.serviceBranch,
      routedBranch,
      inventoryBranch: serialUnit?.branch,
      technicianBranch: req.activeBranch,
    });
    if (branchContext.conflict) return res.status(409).json({ message: branchContext.conflict });
    if (branchContext.technicianMismatch) {
      return res.status(403).json({ message: "This AC unit belongs to another branch." });
    }
    const branch = branchContext.branch;

    const serviceHistory = await ServiceHistory.find({ unit: unit._id })
      .populate("technician", "name name_first name_last")
      .sort({ serviceDate: -1 })
      .lean();
    const relatedTasks = await Task.find({
      $and: [
        branchScopeQuery(req),
        {
          $or: [
            { unitId: String(unit._id) },
            { "payload.unitId": String(unit._id) },
            { "payload.serialNumbers": unit.serialNumber },
            { "payload.items.serialNumbers": unit.serialNumber },
            { "payload.items.serialUnits.serialNumber": unit.serialNumber },
          ],
        },
      ],
    }).sort({ completedAt: -1, updatedAt: -1 }).lean();

    const maintenanceHistory = serviceHistory
      .filter((service) => ["installation", "scheduled_service", "inspection"].includes(String(service.visitType).toLowerCase()))
      .map((service) => ({
      id: String(service._id),
      date: service.serviceDate,
      serviceType: serviceTypeFor(service),
      technician: technicianName(service.technician),
      findings: service.findings || service.technicianInputs?.notes || "No findings recorded",
      actionTaken: service.actionTaken || (service.serviceActions || []).join(", ") || "Actions not recorded",
      hoursSpent: service.hoursSpent ?? null,
      laborCost: service.laborCost ?? null,
      partsCost: service.partsCost ?? null,
      totalServiceCost: service.totalServiceCost ?? null,
      evidence: assessServiceEvidence(service),
      aiInterpretation: service.aiInterpretation?.status ? service.aiInterpretation : null,
      status: "Completed",
      }));
    const repairRows = [
      ...serviceHistory
        .filter((service) => String(service.visitType).toLowerCase() === "repair")
        .map((service) => ({
          id: String(service._id),
          date: service.serviceDate,
          issue: service.findings || service.technicianInputs?.notes || "Repair visit",
          diagnosis: service.findings || service.technicianInputs?.notes || "Findings not recorded",
          actionTaken: service.actionTaken || (service.serviceActions || []).join(", ") || "Actions not recorded",
          partsUsed: (service.partsUsed || []).join(", ") || "None recorded",
          hoursSpent: service.hoursSpent ?? null,
          laborCost: service.laborCost ?? null,
          partsCost: service.partsCost ?? null,
          totalServiceCost: service.totalServiceCost ?? null,
          evidence: assessServiceEvidence(service),
          aiInterpretation: service.aiInterpretation?.status ? service.aiInterpretation : null,
          technician: technicianName(service.technician),
          status: "Completed",
        })),
      ...relatedTasks.filter((relatedTask) => !serviceHistory.some((history) => String(history._id) === String(relatedTask.payload?.serviceHistoryId) || String(history.sourceTaskId) === String(relatedTask._id)) && containsSerial(relatedTask, unit.serialNumber) && /repair|warranty/i.test(`${relatedTask.issueType || ""} ${relatedTask.title || ""}`)).map((relatedTask) => ({
        id: String(relatedTask._id),
        date: relatedTask.completedAt || relatedTask.updatedAt || relatedTask.createdAt,
        issue: relatedTask.description || relatedTask.issueType || relatedTask.title || "Repair request",
        diagnosis: relatedTask.findings || relatedTask.payload?.findings || "Pending technician findings",
        partsUsed: Array.isArray(relatedTask.payload?.partsUsed) ? relatedTask.payload.partsUsed.join(", ") : (relatedTask.payload?.partsUsed || relatedTask.payload?.serviceActions || "Not recorded"),
        technician: relatedTask.assignedTechnicianName || "Technician",
        status: relatedTask.status || "pending",
      })),
    ];
    const warranty = unit.warranty?.toObject?.() || unit.warranty || {};
    const warrantyStatus = effectiveWarrantyStatus(warranty);
    const recommendation = await calculateMaintenanceRecommendation(unit._id);
    const ampHistory = serviceHistory
      .filter((service) => assessServiceEvidence(service).eligible)
      .filter((service) => service.ampSnapshot?.calculatedAt || service.ampSnapshot?.bestServicedBy || service.ampSnapshot?.nextIdealServiceDate)
      .map((service) => ({
        id: String(service._id),
        date: service.ampSnapshot?.calculatedAt || service.serviceDate,
        bestServicedBy: service.ampSnapshot?.bestServicedBy || service.ampSnapshot?.nextIdealServiceDate || "",
        recommendedService: service.ampSnapshot?.recommendedService || service.serviceType || "regular_cleaning",
        recommendationBasis: service.ampSnapshot?.recommendationBasis || "Based on recorded service history.",
      }));
    // Historical assessments must not contain the current calculation.
    // The current plan is returned separately in recommendation.

    return res.json({
      unit: {
        id: String(unit._id),
        qrUnitId: unit.qrUnitId || serialUnit?.qrUnitId || "",
        unitName: [unit.brand, unit.modelName].filter(Boolean).join(" ") || product?.name || "Installed AC Unit",
        brand: unit.brand || product?.brand || "",
        model: unit.modelName || product?.sku || "",
        serialNumber: unit.serialNumber,
        qrCode: unit.qrCode || serialUnit?.qrCode || "",
        installationDate: unit.installation?.installedAt || null,
        // A technician needs to know whether the unit is assigned, not the
        // customer's identity or contact details.
        currentOwner: unit.customer ? "Registered customer" : "Not assigned",
        branch,
        warrantyStatus,
        warrantyExpirationDate: warranty.expirationDate || null,
        warrantyCoverage: getWarrantyCoverage(warranty),
      },
      maintenanceHistory,
      repairHistory: repairRows,
      ampHistory,
      recommendation,
    });
  } catch (error) {
    console.error("Failed to load technician unit history:", error);
    return res.status(500).json({ message: "Unable to load AC unit history right now." });
  }
};

const registerAmpUnit = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const techId = String(req.authUser._id || "");
    if (!task.assignedTechnicianId || String(task.assignedTechnicianId) !== techId) {
      return res.status(403).json({ message: "This task is assigned to another technician." });
    }

    const payload = req.body || {};
    const serialNumber = String(payload.serialNumber || "").trim();
    if (!serialNumber) {
      return res.status(400).json({ message: "Serial number is required." });
    }

    const requiredSerials = getTaskSerialNumbers(task);
    if (requiredSerials.length === 0) {
      return res.status(409).json({ message: "No inventory serial is assigned to this installation. Maintenance work orders do not require QR registration." });
    }
    const assignedSerial = requiredSerials.find(
      (serial) => serial.toLowerCase() === serialNumber.toLowerCase(),
    );
    if (requiredSerials.length > 0 && !assignedSerial) {
      return res.status(400).json({ message: "This AC unit is not part of the selected installation task." });
    }
    if (normalizeStatus(task.status) !== "installing") {
      return res.status(409).json({ message: "Confirm that the customer is present before registering the installed AC unit." });
    }
    if (!hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "Record a verified GPS check-in at the customer location before scanning the assigned AC unit." });
    }
    const arrivalBlocker = installationArrivalBlocker(task);
    if (arrivalBlocker) return res.status(409).json({ message: arrivalBlocker });

    const isDefectiveHold = Boolean(payload.defectiveHold);
    if (isDefectiveHold && !String(payload.defectReason || "").trim()) {
      return res.status(400).json({ message: "Add a defect reason before holding task completion." });
    }
    const roomSizeSqm = Number(payload.roomSizeSqm);
    const installedAt = parseInstallationDateTime(String(payload.installationDate || formatDateKeyInTimeZone(new Date())), String(payload.installationTime || "00:00"));
    if (!installedAt || installedAt > new Date()) return res.status(400).json({ message: "Record a valid installation date and time that is not in the future." });
    if (!isDefectiveHold && (!Number.isFinite(roomSizeSqm) || roomSizeSqm <= 0 || roomSizeSqm > 10000)) {
      return res.status(400).json({ message: "Enter a room size from 1 to 10,000 square meters before registering this AC unit." });
    }

    const normalizedSerialNumber = assignedSerial || serialNumber;
    const { product, serialUnit } = await findProductSerialUnit(normalizedSerialNumber);
    if (!product || !serialUnit) {
      return res.status(404).json({ message: "The assigned QR serial was not found in inventory. Ask an administrator to repair the order inventory before continuing." });
    }
    const previousPlan =
      getAmpRegistrations(task)[normalizedSerialNumber]?.ampServicePlan ||
      serialUnit?.ampRegistration?.ampServicePlan ||
      null;
    const registration = buildRegistrationRecord({
      req,
      task,
      serialNumber: normalizedSerialNumber,
      payload,
      status: isDefectiveHold ? "defective_hold" : "registered",
      previousPlan,
    });

    if (product && serialUnit) {
      if (isDefectiveHold) {
        serialUnit.status = "service";
        serialUnit.defectHold = registration;
      } else {
        // AMP registration proves the technician recorded the installation
        // details, but the unit is not sold/installed until the complete task
        // transition passes its proof checks. This keeps inventory, orders,
        // and customer AC-unit records on one lifecycle.
        serialUnit.status = "assigned";
        serialUnit.ampRegistration = registration;
        serialUnit.defectHold = {};
      }
      await product.save();
    }

    task.payload = {
      ...(task.payload || {}),
      ampRegistrations: {
        ...getAmpRegistrations(task),
        [normalizedSerialNumber]: registration,
      },
      updatedAt: new Date().toISOString(),
    };

    const progressAfterRegistration = getRegistrationProgress(task);
    task.status = isDefectiveHold || progressAfterRegistration.totalHeld > 0
      ? "on-hold"
      : task.status;
    task.payload.status = task.status;
    task.completedAt = null;

    await task.save();
    await syncOrderWorkflowForTask(task, task.status);

    return res.json({
      task: hydrateTaskResponse(task),
      registration,
      registrationProgress: getRegistrationProgress(task),
    });
  } catch (error) {
    console.error("Failed to register AMP unit:", error);
    return res.status(500).json({ message: "Unable to submit AMP registration right now." });
  }
};

const updateTaskStatus = async (req, res) => {
  try {
    const status = parseTaskStatus(req.body?.status);
    const allowed = ["pending", "accepted", "on-the-way", "arrived", "installing", "in-progress", "on-hold", "failed", "rescheduled", "completed"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid task status." });
    }
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (normalizeStatus(task.status) === "completed" && status === "completed") {
      await reconcileCompletedTask(task);
      return res.json({ task: hydrateTaskResponse(task), replayed: true });
    }

    const mutationBlocker = awaitingVisitFollowUp(task) ? FOLLOW_UP_REQUIRED : getTaskMutationBlocker(task.status);
    if (mutationBlocker) {
      return res.status(409).json({ message: mutationBlocker });
    }

    if (req.authUser.role === "technician") {
      const currentTechId = String(req.authUser._id || "");
      if (!task.assignedTechnicianId || String(task.assignedTechnicianId) !== currentTechId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (normalizeStatus(task.status) === "pending") {
        return res.status(409).json({ message: "This work order must be activated by an administrator before work can begin." });
      }
    }

    const payload = req.body || {};
    const costError = validateServiceCosts(payload);
    if (costError) return res.status(400).json({ message: costError });
    const costMutationError = await serviceCostMutationBlocker(task, payload);
    if (costMutationError) return res.status(409).json({ message: costMutationError });
    const proof = buildTaskProof({ task, payload, req, nextStatus: status });
    if (["arrived", "installing"].includes(status) && !hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "The assigned technician must check in with GPS before arrival or installation can be confirmed." });
    }
    const currentStatus = normalizeStatus(task.status);
    if (
      req.authUser.role === "technician" &&
      status !== currentStatus &&
      !["completed", "on-hold", "failed", "rescheduled"].includes(status)
    ) {
      return res.status(409).json({ message: "Admin controls work-order activation. Technicians can complete, hold, fail, or request rescheduling only after activation." });
    }
    const lifecycleOrder = ["pending", "accepted", "on-the-way", "arrived", "installing", "completed"];
    const currentIndex = lifecycleOrder.indexOf(currentStatus);
    const nextIndex = lifecycleOrder.indexOf(status);
    if (req.authUser.role === "technician" && status !== "failed" && status !== "rescheduled" && status !== "on-hold" && currentIndex >= 0 && nextIndex >= 0 && nextIndex > currentIndex + 1) {
      return res.status(409).json({ message: `Move this work order through ${lifecycleOrder[currentIndex + 1]} before marking it ${status}.` });
    }
    if (req.authUser.role === "technician" && ["installing", "completed"].includes(status) && !["arrived", "installing", "in-progress"].includes(currentStatus)) {
      return res.status(409).json({ message: "Check in at the customer location before starting installation." });
    }
    if (req.authUser.role === "technician" && status === "completed" && !hasVerifiedTaskCheckIn(task)) {
      return res.status(409).json({ message: "Record a verified GPS check-in at the customer location before completing this work order." });
    }
    if (req.authUser.role === "technician" && status === "completed") {
      const arrivalBlocker = installationArrivalBlocker(task);
      if (arrivalBlocker) return res.status(409).json({ message: arrivalBlocker });
    }
    task.status = status;
    if (status === "completed") {
      const servicePaymentError = await getServiceCompletionPaymentBlocker(task);
      if (servicePaymentError) return res.status(409).json({ message: servicePaymentError });
      const reportError = validateCompletionReport(task, payload);
      if (reportError) {
        return res.status(reportError.status).json({ message: reportError.message, errors: reportError.errors });
      }
      const completionError = assertCanCompleteTask(task);
      if (completionError) {
        return res.status(completionError.status).json({
          message: completionError.message,
          registrationProgress: completionError.progress,
        });
      }
      const proofError = assertInstallationProof(task, proof, payload);
      if (proofError) {
        return res.status(proofError.status).json({ message: proofError.message });
      }
      const orderCompletionBlocker = await getOrderCompletionBlocker(task);
      if (orderCompletionBlocker) {
        return res.status(409).json({ message: orderCompletionBlocker });
      }
    }
    task.completedAt = status === "completed" ? new Date() : null;
    task.proof = proof;
    const persistedPayload = req.authUser.role === "technician"
      ? technicianReportPayload(payload)
      : payload;
    task.payload = {
      ...withoutEmbeddedProofMedia(task.payload),
      ...withoutEmbeddedProofMedia(persistedPayload),
      status,
      updatedAt: new Date().toISOString(),
    };
    if (status === "on-the-way" && !task.payload.onTheWayAt) {
      task.payload.onTheWayAt = new Date().toISOString();
    }
    if (status === "installing" && hasVerifiedTaskCheckIn(task) && !task.payload.installationStartedAt) {
      task.payload.installationStartedAt = new Date().toISOString();
    }
    await task.save();
    await syncServicePaymentForTask(task);
    await syncOrderWorkflowForTask(task, status);
    await syncServiceRequestForTask(task, status);
    // Installation work orders are not linked to a service-request record,
    // but they still form the first entry in the AC unit's history.
    if (status === "completed" && !String(task.payload?.requestId || "").trim()) {
      const completedHistory = await recordCompletedServiceHistory(task, {});
      await notifyCustomerOfCompletedService(task, {}, completedHistory);
    }

    return res.json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to update task status:", error);
    return res.status(500).json({ message: "Unable to update task status right now." });
  }
};

module.exports = {
  ensureInstalledCustomerUnitsForTask,
  buildCustomerTaskScopeQuery,
  listTasks,
  createTask,
  updateTask,
  getTaskById,
  acceptTask,
  checkInTask,
  confirmInstallationArrival,
  confirmCodCollection,
  getRegistrationContextBySerial,
  getTechnicianUnitHistoryBySerial,
  registerAmpUnit,
  updateTaskStatus,
};
