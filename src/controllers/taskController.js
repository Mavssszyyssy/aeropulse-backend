const mongoose = require("mongoose");
const Task = require("../models/Task");
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");
const Unit = require("../models/Unit");
const ServiceRequest = require("../models/ServiceRequest");
const Notification = require("../models/Notification");
const { notifyOperationalStaff } = require("../services/operationalNotificationService");
const ServiceHistory = require("../models/ServiceHistory");
const { estimateNextServiceWindow } = require("../domain/ampServiceEstimator");
const { BRANCH_PRIORITY, resolvePreferredBranch } = require("../domain/branchRouting");
const { buildActivatedWarranty, appendWarrantyEvent, effectiveWarrantyStatus } = require("../domain/warrantyService");

const branchScopeQuery = (req) => {
  if (req.authUser.role === "superadmin") return {};
  const branch = req.activeBranch;
  if (!branch) return {};
  return { $or: [{ branch }, { branch: "" }, { branch: { $exists: false } }] };
};

const findTaskForRequest = async (taskId, req) => {
  const conditions = [{ taskCode: taskId }];
  if (mongoose.Types.ObjectId.isValid(taskId)) {
    conditions.unshift({ _id: taskId });
  }
  return Task.findOne({ $and: [{ $or: conditions }, branchScopeQuery(req)] });
};

const normalizeStatus = (value = "") => {
  const normalized = String(value || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  if ([
    "pending",
    "accepted",
    "on-the-way",
    "arrived",
    "installing",
    "in-progress",
    "on-hold",
    "failed",
    "rescheduled",
    "completed",
  ].includes(normalized)) return normalized;
  if (normalized === "in_progress") return "in-progress";
  if (normalized === "on_hold") return "on-hold";
  return "pending";
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
  if (getTaskSerialNumbers(task).length === 0) return null;

  const hasInstallationPhoto = (proof?.afterPhotos || []).some((photo) =>
    Boolean(String(photo?.uri || "").trim()),
  );
  if (hasInstallationPhoto) return null;

  return {
    status: 409,
    message: "Installation proof is incomplete. Add an installed-unit photo before closing this work order.",
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

const getOrderCompletionBlocker = async (task) => {
  const order = await findLinkedOrderForTask(task);
  if (!order || order.workflowStatus === "complete") return null;
  if (order.workflowStatus === "to_install") return null;
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
  const installedAt = ampParameters.installationTimestamp
    ? new Date(ampParameters.installationTimestamp)
    : ampParameters.installationDate
      ? new Date(ampParameters.installationDate)
      : new Date();
  const nextServiceDate = registration.ampServicePlan?.nextServiceDate
    ? new Date(registration.ampServicePlan.nextServiceDate)
    : null;

  const existingUnit = await Unit.findOne({ serialNumber }).select("warranty");
  const warranty = buildActivatedWarranty(existingUnit?.warranty, installedAt);

  return Unit.findOneAndUpdate(
    { serialNumber },
    {
      $set: {
        serialNumber,
        qrCode: String(serialUnit?.qrCode || ""),
        qrUnitId: String(serialUnit?.qrUnitId || ""),
        productId: String(product?._id || product?.id || ""),
        modelName: [product?.name, product?.specs].filter(Boolean).join(" ") || product?.sku || "AC Unit",
        brand: String(product?.brand || ""),
        capacityHp: parseCapacityHp(product?.specs),
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
          currentHealthScore: 100,
          serviceThreshold: 60,
          dailyBaseDecay: 0.22,
          historicalCurveFactor: 1,
          nextIdealServicePeriod: String(registration.ampServicePlan?.label || ""),
          nextIdealServiceDate: nextServiceDate && !Number.isNaN(nextServiceDate.getTime())
            ? nextServiceDate
            : null,
          lastCalculatedAt: new Date(),
        },
        warranty,
        status: "active",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
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
  const timestamp = normalizedStatus === "arrived"
    ? task.payload?.checkIn?.checkedInAt || new Date()
    : normalizedStatus === "completed" ? task.completedAt || new Date() : new Date();
  appendOrderTrackingEvent(order, normalizedStatus, timestamp);
  if (task.assignedTechnicianName && !order.assignedTechnician) {
    order.assignedTechnician = task.assignedTechnicianName;
  }
  if (normalizedStatus !== "completed") {
    await order.save();
    if (!["pending", "accepted"].includes(normalizedStatus)) {
      await notifyOperationalStaff({
        branch: task.branch || order.stockSourceBranch || order.customerBranch || "",
        title: "Technician status update",
        message: `${task.assignedTechnicianName || "A technician"} marked ${order.orderCode || "an order"} as ${normalizedStatus.replace(/-/g, " ")}.`,
        type: "technician",
        category: "task",
        targetId: String(task._id || task.id || ""),
        targetType: "task",
        dedupeKey: `task-status:${task._id || task.taskCode}:${normalizedStatus}`,
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
  order.status = "paid";
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

const syncServiceRequestForTask = async (task, status) => {
  const normalizedStatus = normalizeStatus(status || task.status);
  const requestId = String(task.payload?.requestId || task.requestId || "").trim();
  if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) return;

  let nextStatus = "";
  if (["pending", "accepted"].includes(normalizedStatus)) nextStatus = "Assigned";
  if (["on-the-way", "arrived", "installing", "in-progress"].includes(normalizedStatus)) nextStatus = "In Progress";
  if (normalizedStatus === "on-hold") nextStatus = "Assigned";
  if (normalizedStatus === "completed") nextStatus = "Completed";
  if (!nextStatus) return;

  const request = await ServiceRequest.findById(requestId);
  if (!request) return;

  request.status = nextStatus;
  request.assignedTechnicianId = task.assignedTechnicianId || request.assignedTechnicianId || "";
  request.assignedTechnicianName = task.assignedTechnicianName || request.assignedTechnicianName || "";
  const timeline = Array.isArray(request.payload?.timeline) ? request.payload.timeline : [];
  const alreadyLogged = timeline.some(
    (event) =>
      String(event.title || "") === `Task changed to ${nextStatus}` &&
      Math.abs(new Date(event.timestamp || 0).getTime() - Date.now()) < 5000,
  );
  request.payload = {
    ...(request.payload || {}),
    linkedTaskId: String(task._id || task.id || ""),
    taskCode: task.taskCode,
    assignedTechnicianId: request.assignedTechnicianId,
    assignedTechnicianName: request.assignedTechnicianName,
    status: nextStatus,
    completedAt:
      nextStatus === "Completed"
        ? request.payload?.completedAt || new Date().toISOString()
        : request.payload?.completedAt || null,
    timeline: alreadyLogged
      ? timeline
      : [
          ...timeline,
          {
            id: `service_timeline_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            title: `Task changed to ${nextStatus}`,
            description: `Technician task updated to ${nextStatus}.`,
            actor: task.assignedTechnicianName || "Technician",
            timestamp: new Date().toISOString(),
          },
        ],
    updatedAt: new Date().toISOString(),
  };

  await request.save();
  if (nextStatus === "Completed") await completeWarrantyClaimForServiceTask(task, request);
  const customerId = String(request.customerId || task.customerId || "").trim();
  if (nextStatus === "Completed" && !task.payload?.orderId && !task.orderId && customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    const targetId = String(task._id || task.id || request._id || "");
    const alreadyNotified = await Notification.exists({ user: customerId, targetId, title: "Service completed" });
    if (!alreadyNotified) {
      await Notification.create({
        user: customerId,
        type: "order",
        title: "Service completed",
        message: `Your technician service request for ${request.issue || "your AC unit"} has been completed.`,
        route: "/customer/service-requests",
        targetId,
      });
    }
  }
};

const buildRegistrationRecord = ({ req, task, serialNumber, payload, status, previousPlan = null }) => {
  const installationDate = String(payload.installationDate || new Date().toISOString().split("T")[0]);
  const installationTime = String(payload.installationTime || new Date().toTimeString().slice(0, 5));
  const ampParameters = {
    installationDate,
    installationTime,
    installationTimestamp: `${installationDate}T${installationTime}:00`,
    lastServiceDate: String(payload.lastServiceDate || payload.installationDate || new Date().toISOString()),
    placementArea: String(payload.placementArea || ""),
    usageHoursPerDay: Number(payload.usageHoursPerDay || 8),
    environmentDustLevel: String(payload.environmentDustLevel || "moderate"),
    occupancyLoad: String(payload.occupancyLoad || "normal"),
    filterCondition: String(payload.filterCondition || "normal"),
    coilCondition: String(payload.coilCondition || "normal"),
    drainageCondition: String(payload.drainageCondition || "clear"),
    voltageStability: String(payload.voltageStability || "stable"),
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
      placementArea: ampParameters.placementArea,
      filterCondition: ampParameters.filterCondition,
      coilCondition: ampParameters.coilCondition,
      drainageCondition: ampParameters.drainageCondition,
      conditionRating: ampParameters.conditionRating,
      notes: ampParameters.notes,
      recordedAt: new Date().toISOString(),
    },
    defectReason: String(payload.defectReason || ""),
    ampServicePlan: status === "registered"
      ? estimateNextServiceWindow(ampParameters, previousPlan)
      : null,
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

const hydrateTaskResponse = (task) => {
  const payload = task.payload && Object.keys(task.payload).length ? task.payload : null;
  const progress = getRegistrationProgress(task);
  const base = task.toJSON();
  if (!payload) {
    return {
      ...base,
      proof: task.proof || {},
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
    proof: payload.proof || task.proof || {},
    registrationProgress: progress,
    status: task.status,
    createdAt: payload.createdAt || task.createdAt,
    updatedAt: payload.updatedAt || task.updatedAt,
  };
};

const listTasks = async (req, res) => {
  try {
    const role = req.authUser.role;
    const technicianId = String(req.query?.technician_id || "").trim();
    const scopeQuery = branchScopeQuery(req);
    let query = { ...scopeQuery };

    if (role === "technician") {
      query = {
        $and: [
          scopeQuery,
          {
            $or: [
            { assignedTechnicianId: String(req.authUser._id || "") },
            ],
          },
        ],
      };
    } else if (technicianId) {
      query.assignedTechnicianId = technicianId;
    }

    const tasks = await Task.find(query).sort({ updatedAt: -1 }).limit(200);
    return res.json({ tasks: tasks.map(hydrateTaskResponse) });
  } catch (error) {
    console.error("Failed to list tasks:", error);
    return res.status(500).json({ message: "Unable to fetch tasks right now." });
  }
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
      assignedTechnicianName: String(payload.assignedTechnicianName || ""),
      status: normalizeStatus(payload.status),
      priority: String(payload.priority || "medium").toLowerCase(),
      scheduledDate: String(payload.scheduledDate || payload.preferredDate || "TBD"),
      timeSlot: String(payload.timeSlot || payload.preferredSchedule || "TBD"),
      assignedRole: String(payload.assignedRole || "technician"),
      branch: req.authUser.role === "superadmin" ? String(payload.branch || "") : req.activeBranch,
      completedAt: normalizeStatus(payload.status) === "completed" ? new Date() : null,
      payload: { ...payload, createdAt: payload.createdAt || nowIso, updatedAt: payload.updatedAt || nowIso },
    });

    return res.status(201).json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to create task:", error);
    return res.status(500).json({ message: "Unable to create task right now." });
  }
};

const updateTask = async (req, res) => {
  try {
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
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
    const nextStatus = normalizeStatus(payload.status || task.status);
    const proof = buildTaskProof({ task, payload, req, nextStatus });
    const currentStatus = normalizeStatus(task.status);
    const lifecycleOrder = ["pending", "accepted", "on-the-way", "arrived", "installing", "completed"];
    const currentIndex = lifecycleOrder.indexOf(currentStatus);
    const nextIndex = lifecycleOrder.indexOf(nextStatus);
    if (req.authUser.role === "technician" && nextStatus !== "failed" && nextStatus !== "rescheduled" && nextStatus !== "on-hold" && currentIndex >= 0 && nextIndex >= 0 && nextIndex > currentIndex + 1) {
      return res.status(409).json({ message: `Move this work order through ${lifecycleOrder[currentIndex + 1]} before marking it ${nextStatus}.` });
    }
    if (req.authUser.role === "technician" && ["installing", "completed"].includes(nextStatus) && !["arrived", "installing", "in-progress"].includes(currentStatus)) {
      return res.status(409).json({ message: "Check in at the customer location before starting installation." });
    }
    const updatedPayload = {
      ...(task.payload || {}),
      ...payload,
      proof,
      status: payload.status || task.status,
      updatedAt: new Date().toISOString(),
    };
    if (nextStatus === "on-the-way" && !updatedPayload.onTheWayAt) {
      updatedPayload.onTheWayAt = new Date().toISOString();
    }
    if (["installing", "in-progress"].includes(nextStatus) && !updatedPayload.installationStartedAt) {
      updatedPayload.installationStartedAt = new Date().toISOString();
    }

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
    task.status = nextStatus;
    task.priority = String(payload.priority || task.priority || "medium").toLowerCase();
    task.scheduledDate = String(payload.scheduledDate || payload.preferredDate || task.scheduledDate || "TBD");
    task.timeSlot = String(payload.timeSlot || payload.preferredSchedule || task.timeSlot || "TBD");
    if (nextStatus === "completed") {
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
    await syncOrderWorkflowForTask(task, nextStatus);
    await syncServiceRequestForTask(task, nextStatus);
    return res.json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to update task:", error);
    return res.status(500).json({ message: "Unable to update task right now." });
  }
};

const getTaskById = async (req, res) => {
  try {
    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    return res.json({ task: hydrateTaskResponse(task) });
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

    const coordinates = req.body?.coordinates || req.body?.location?.coordinates || {};
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

    const unit = await Unit.findOne({ serialNumber: new RegExp(`^${serialNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (!unit) return res.status(404).json({ message: "No installed AC unit was found for this QR label." });

    const { product, serialUnit } = await findProductSerialUnit(unit.serialNumber);
    const branch = serialUnit?.branch || await resolvePreferredBranch({
      city: unit.installation?.city,
      province: unit.installation?.province,
    });
    if (req.activeBranch && branch && branch !== req.activeBranch) {
      return res.status(403).json({ message: "This AC unit belongs to another branch." });
    }

    const serviceHistory = await ServiceHistory.find({ unit: unit._id })
      .populate("technician", "name name_first name_last")
      .sort({ serviceDate: -1 })
      .limit(100)
      .lean();
    const relatedTasks = await Task.find({
      $and: [
        branchScopeQuery(req),
        {
          $or: [
            { unitId: String(unit._id) },
            { "payload.serialNumbers": unit.serialNumber },
            { "payload.items.serialNumbers": unit.serialNumber },
            { "payload.items.serialUnits.serialNumber": unit.serialNumber },
          ],
        },
      ],
    }).sort({ completedAt: -1, updatedAt: -1 }).limit(100).lean();

    const serviceRows = serviceHistory.map((service) => ({
      id: String(service._id),
      date: service.serviceDate,
      serviceType: service.visitType,
      technician: technicianName(service.technician),
      findings: service.technicianInputs?.notes || service.conditionRating || "No findings recorded",
      actionTaken: Array.isArray(service.serviceActions) && service.serviceActions.length
        ? service.serviceActions.join(", ")
        : "Service completed",
      status: "Completed",
    }));
    const repairRows = [
      ...serviceRows.filter((service) => String(service.serviceType).toLowerCase() === "repair"),
      ...relatedTasks.filter((task) => containsSerial(task, unit.serialNumber) && /repair|warranty/i.test(`${task.issueType || ""} ${task.title || ""}`)).map((task) => ({
        id: String(task._id),
        date: task.completedAt || task.updatedAt || task.createdAt,
        issue: task.description || task.issueType || task.title || "Repair request",
        diagnosis: task.findings || task.payload?.findings || "Pending technician findings",
        partsUsed: Array.isArray(task.payload?.partsUsed) ? task.payload.partsUsed.join(", ") : (task.payload?.partsUsed || task.payload?.serviceActions || "Not recorded"),
        technician: task.assignedTechnicianName || "Technician",
        status: task.status || "pending",
      })),
    ];
    const warranty = unit.warranty?.toObject?.() || unit.warranty || {};
    const warrantyStatus = effectiveWarrantyStatus(warranty);
    const healthScore = Number(unit.amp?.currentHealthScore ?? 100);
    const riskLevel = healthScore <= 45 ? "High" : healthScore <= 70 ? "Moderate" : "Low";
    const latestInputs = serviceHistory[0]?.technicianInputs || {};

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
        currentOwner: unit.customerName || "Customer",
        branch,
        warrantyStatus,
        warrantyExpirationDate: warranty.expirationDate || null,
      },
      maintenanceHistory: serviceRows.filter((service) => ["installation", "scheduled_service", "inspection"].includes(String(service.serviceType).toLowerCase())),
      repairHistory: repairRows,
      ampHistory: [{
        date: unit.amp?.lastCalculatedAt || serviceHistory[0]?.serviceDate || unit.updatedAt,
        period: unit.amp?.nextIdealServicePeriod || "Current assessment",
        usageData: latestInputs.usageHoursPerDay ? `${latestInputs.usageHoursPerDay} hrs/day` : "Not recorded",
        healthScore,
        riskLevel,
        recommendation: unit.amp?.nextIdealServiceDate
          ? `Inspect by ${new Date(unit.amp.nextIdealServiceDate).toLocaleDateString("en-US")}.`
          : "Continue preventive maintenance and record technician findings.",
      }],
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
    const assignedSerial = requiredSerials.find(
      (serial) => serial.toLowerCase() === serialNumber.toLowerCase(),
    );
    if (requiredSerials.length > 0 && !assignedSerial) {
      return res.status(400).json({ message: "This AC unit is not part of the selected installation task." });
    }
    if (normalizeStatus(task.status) !== "in-progress") {
      return res.status(409).json({ message: "This work order must be activated by an administrator before the AC unit can be registered." });
    }

    const isDefectiveHold = Boolean(payload.defectiveHold);
    if (isDefectiveHold && !String(payload.defectReason || "").trim()) {
      return res.status(400).json({ message: "Add a defect reason before holding task completion." });
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
    const status = normalizeStatus(req.body?.status);
    const allowed = ["pending", "accepted", "on-the-way", "arrived", "installing", "in-progress", "on-hold", "failed", "rescheduled", "completed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid task status." });
    }

    const task = await findTaskForRequest(req.params.taskId, req);
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
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
    const proof = buildTaskProof({ task, payload, req, nextStatus: status });
    const currentStatus = normalizeStatus(task.status);
    const lifecycleOrder = ["pending", "accepted", "on-the-way", "arrived", "installing", "completed"];
    const currentIndex = lifecycleOrder.indexOf(currentStatus);
    const nextIndex = lifecycleOrder.indexOf(status);
    if (req.authUser.role === "technician" && status !== "failed" && status !== "rescheduled" && status !== "on-hold" && currentIndex >= 0 && nextIndex >= 0 && nextIndex > currentIndex + 1) {
      return res.status(409).json({ message: `Move this work order through ${lifecycleOrder[currentIndex + 1]} before marking it ${status}.` });
    }
    if (req.authUser.role === "technician" && ["installing", "completed"].includes(status) && !["arrived", "installing", "in-progress"].includes(currentStatus)) {
      return res.status(409).json({ message: "Check in at the customer location before starting installation." });
    }
    task.status = status;
    if (status === "completed") {
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
    task.payload = {
      ...(task.payload || {}),
      ...payload,
      proof,
      status,
      updatedAt: new Date().toISOString(),
    };
    if (status === "on-the-way" && !task.payload.onTheWayAt) {
      task.payload.onTheWayAt = new Date().toISOString();
    }
    if (["installing", "in-progress"].includes(status) && !task.payload.installationStartedAt) {
      task.payload.installationStartedAt = new Date().toISOString();
    }
    await task.save();
    await syncOrderWorkflowForTask(task, status);
    await syncServiceRequestForTask(task, status);

    return res.json({ task: hydrateTaskResponse(task) });
  } catch (error) {
    console.error("Failed to update task status:", error);
    return res.status(500).json({ message: "Unable to update task status right now." });
  }
};

module.exports = {
  listTasks,
  createTask,
  updateTask,
  getTaskById,
  acceptTask,
  checkInTask,
  getRegistrationContextBySerial,
  getTechnicianUnitHistoryBySerial,
  registerAmpUnit,
  updateTaskStatus,
};
