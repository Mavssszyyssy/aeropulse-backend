// services/taskStorage.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as api from "./api";
import {
  SERVICE_REQUEST_STATUS,
  assignTechnicianToServiceRequest,
  updateServiceRequestStatus,
} from "./serviceRequestStorage";

const STORAGE_KEY = "technician_tasks_storage_v2";

export const TASK_STATUS = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  ON_THE_WAY: "On the way",
  ARRIVED: "Arrived",
  INSTALLING: "Installing",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  FAILED: "Failed",
  RESCHEDULED: "Rescheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

function normalizeTaskStatus(status) {
  const value = String(status || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (value === "in-progress") return TASK_STATUS.IN_PROGRESS;
  if (value === "accepted") return TASK_STATUS.ACCEPTED;
  if (value === "on-the-way") return TASK_STATUS.ON_THE_WAY;
  if (value === "arrived") return TASK_STATUS.ARRIVED;
  if (value === "installing") return TASK_STATUS.INSTALLING;
  if (value === "completed") return TASK_STATUS.COMPLETED;
  if (value === "failed") return TASK_STATUS.FAILED;
  if (value === "rescheduled") return TASK_STATUS.RESCHEDULED;
  if (value === "cancelled" || value === "canceled") return TASK_STATUS.CANCELLED;
  if (value === "on-hold") return TASK_STATUS.ON_HOLD;
  return TASK_STATUS.PENDING;
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function createTimelineEvent({ title, description = "", actor = "System", timestamp }) {
  return {
    id: `task_timeline_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    title: title || "Task Updated",
    description: description || "",
    actor: actor || "System",
    timestamp: timestamp || new Date().toISOString(),
  };
}

export function normalizeTask(item = {}) {
  const payload =
    item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
      ? item.payload
      : {};
  const value = (key, fallback = "") =>
    item[key] !== undefined && item[key] !== null && item[key] !== ""
      ? item[key]
      : payload[key] ?? fallback;
  const createdAt = value("createdAt", new Date().toISOString());
  const title = value("title") || value("issueType") || "Service Task";
  const description =
    value("description") || value("concern") || value("issueDescription") || "";
  const orderItems = Array.isArray(item.items)
    ? item.items
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  const suppliedSerials = [
    ...(Array.isArray(item.serialNumbers) ? item.serialNumbers : []),
    ...(Array.isArray(payload.serialNumbers) ? payload.serialNumbers : []),
  ];
  const serialNumbers = Array.from(
    new Set(
      [...suppliedSerials, ...orderItems
        .flatMap((orderItem) => [
          ...(Array.isArray(orderItem.serialNumbers) ? orderItem.serialNumbers : []),
          ...(Array.isArray(orderItem.serialUnits)
            ? orderItem.serialUnits.map((unit) => unit?.serialNumber)
            : []),
        ])]
        .map((serial) => String(serial || "").trim())
        .filter(Boolean),
    ),
  );
  const cost = key => { const raw = value(key, null); const n = raw === null || raw === "" ? null : Number(raw); return Number.isFinite(n) && n >= 0 ? n : null; };
  const laborCost = cost("laborCost");
  const partsCost = cost("partsCost");
  const additionalCost = cost("additionalCost");
  const recordedCosts = [laborCost, partsCost, additionalCost].filter(n => n !== null);
  const totalServiceCost = recordedCosts.length ? Math.round(recordedCosts.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  const proof = item.proof && typeof item.proof === "object"
    ? item.proof
    : {
        beforePhotos: item.beforePhotoUri ? [{ uri: item.beforePhotoUri, label: "Before service" }] : [],
        afterPhotos: item.afterPhotoUri ? [{ uri: item.afterPhotoUri, label: "After service" }] : [],
        customerSignature: {
          name: item.customerSignatureName || "",
          signature: item.customerSignature || "",
          signedAt: item.customerSignedAt || "",
        },
        technicianName: item.technicianName || item.assignedTechnicianName || "",
        submittedAt: item.proofSubmittedAt || "",
        notes: item.proofNotes || item.notes || "",
      };
  const completionNotes =
    item.completionNotes ||
    [item.findings, item.resolution, item.notes].filter(Boolean).join(" | ");

  return {
    id: value("id") || `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    taskCode: value("taskCode"),
    orderId: value("orderId"),
    orderCode: value("orderCode"),
    codPayment: value("codPayment", null),
    orderPayment: value("orderPayment", null),
    servicePayment: value("servicePayment", null),
    completionSynchronized: value("completionSynchronized", null),
    items: orderItems,
    serialNumbers,
    registrationProgress: value("registrationProgress", null),
    ampRegistrations: value("ampRegistrations", {}),
    requestId: value("requestId"),
    unit: value("unit", null),
    title,
    description,
    customerId: value("customerId") || value("userId"),
    customerName: value("customerName") || value("customer"),
    customerEmail: value("customerEmail"),
    customerPhone: value("customerPhone"),
    issueType: value("issueType"),
    concern: description,
    unitId: value("unitId", null),
    unitName:
      value("unitName") ||
      value("unitType") ||
      orderItems.map((orderItem) => orderItem.name).filter(Boolean).join(", "),
    unitType: value("unitType") || value("unitName"),
    address: value("address"),
    plusCode: value("plusCode"),
    assignedTechnicianId: value("assignedTechnicianId"),
    assignedTechnicianName: value("assignedTechnicianName"),
    priority: value("priority") || "Normal",
    scheduledDate:
      value("scheduledDate") || value("preferredDate") || value("preferredSchedule"),
    status: normalizeTaskStatus(value("status")),
    findings: value("findings"),
    resolution: value("resolution"),
    beforeCondition: value("beforeCondition"),
    afterCondition: value("afterCondition"),
    conditionRating: value("conditionRating"),
    serviceType: value("serviceType"),
    serviceActions: value("serviceActions", []),
    serviceLogs: value("serviceLogs", []),
    partsUsed: value("partsUsed"),
    laborCost,
    partsCost,
    additionalCost,
    totalServiceCost,
    nextMaintenanceDate: item.nextMaintenanceDate || "",
    customerAdvice: item.customerAdvice || "",
    proof,
    checkIn: value("checkIn", null),
    arrivalValidation: value("arrivalValidation", null),
    beforePhotoUri: item.beforePhotoUri || proof.beforePhotos?.[0]?.uri || "",
    afterPhotoUri: item.afterPhotoUri || proof.afterPhotos?.[0]?.uri || "",
    customerSignatureName: item.customerSignatureName || proof.customerSignature?.name || "",
    customerSignature: item.customerSignature || proof.customerSignature?.signature || "",
    proofSubmittedAt: item.proofSubmittedAt || proof.submittedAt || "",
    completionNotes,
    notes: value("notes"),
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    timeline:
      Array.isArray(item.timeline) && item.timeline.length > 0
        ? item.timeline
        : [
            createTimelineEvent({
              title: "Task Created",
              description: "Technician task created.",
              actor: "System",
              timestamp: createdAt,
            }),
          ],
    createdAt,
    updatedAt: item.updatedAt || createdAt,
    visitAttempt: value('visitAttempt') || null,
  };
}

function appendTimeline(task, event) {
  const existing = Array.isArray(task.timeline) ? task.timeline : [];
  return [...existing, event];
}

const isEmbeddedProofImage = (value) =>
  String(value || "").startsWith("data:image/");

const taskForOfflineCache = (task = {}) => {
  const proof = task.proof && typeof task.proof === "object" ? task.proof : {};
  const keepRemotePhotos = (photos) =>
    (Array.isArray(photos) ? photos : []).filter(
      (photo) => !isEmbeddedProofImage(photo?.uri || photo),
    );

  return {
    ...task,
    proof: {
      ...proof,
      beforePhotos: keepRemotePhotos(proof.beforePhotos),
      afterPhotos: keepRemotePhotos(proof.afterPhotos),
    },
    beforePhotoUri: isEmbeddedProofImage(task.beforePhotoUri) ? "" : task.beforePhotoUri,
    afterPhotoUri: isEmbeddedProofImage(task.afterPhotoUri) ? "" : task.afterPhotoUri,
  };
};

export async function getAllTasks() {
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.fetchTasks(token);
      if (result.success) {
        await saveAllTasks(result.tasks);
        return result.tasks.map(normalizeTask);
      }
    }
  } catch {}

  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const parsed = safeParse(raw, []);
  return Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
}

export async function loadTasks() {
  return getAllTasks();
}

export async function saveAllTasks(items = []) {
  const normalized = items.map(normalizeTask);
  // Proof photos remain authoritative on the backend. Keeping base64 camera
  // images in the shared offline task cache can exceed the native storage
  // quota after an otherwise successful completion request.
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(normalized.map(taskForOfflineCache)),
  );
  return normalized;
}

export async function getTaskById(taskId, { requireOnline = false } = {}) {
  const normalizedTaskId = Array.isArray(taskId) ? taskId[0] : taskId;
  let connectionFailed = false;
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.fetchTask(token, normalizedTaskId);
      if (result.success) return normalizeTask(result.task);
      // A response from the server is authoritative. Falling back to an old
      // local copy for a 401/403/404 made Work Details report a misleading
      // missing task and could send a technician into the wrong installation.
      throw new Error(result.error || "Unable to load this work order.");
    }
  } catch (error) {
    if (requireOnline) throw error;
    connectionFailed = true;
    if (error?.message && !/network request failed|failed to fetch|timed out/i.test(error.message)) {
      throw error;
    }
  }

  if (requireOnline) throw new Error("Please sign in again to verify the current work order assignment.");
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const cachedTasks = safeParse(raw, []);
  const cachedTask = Array.isArray(cachedTasks)
    ? cachedTasks.find((item) => String(item?.id) === String(normalizedTaskId))
    : null;
  if (cachedTask) return normalizeTask(cachedTask);

  if (connectionFailed) {
    throw new Error("Unable to reach the server. Check the connection and try again.");
  }
  return null;
}

export async function createTask(payload = {}, actor = "Admin") {
  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again before creating a task.");
  const result = await api.createTask(token, normalizeTask(payload));
  if (!result.success) throw new Error(result.error || "Unable to create the task.");
  const created = normalizeTask(result.task);
  const tasks = await getAllTasks();
  await saveAllTasks([created, ...tasks.filter((task) => task.id !== created.id)]);
  return created;
}

export async function updateTask(taskId, patch = {}) {
  if (typeof taskId === "object" && taskId !== null) {
    const task = taskId;
    return updateTask(task.id, task);
  }

  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again before updating a task.");
  const existing = await getTaskById(taskId);
  const payload = normalizeTask({
    ...(existing || {}),
    ...patch,
    id: taskId,
    updatedAt: new Date().toISOString(),
  });
  const result = await api.patchTask(token, taskId, payload);
  if (!result.success) throw new Error(result.error || "Unable to update the task.");
  const updated = normalizeTask(result.task);
  const tasks = await getAllTasks();
  await saveAllTasks(
    tasks.map((item) => (String(item.id) === String(taskId) ? updated : item)),
  );
  return updated;
}

export async function updateTaskStatus(taskId, status, actor = "Technician", patch = {}) {
  const tasks = await getAllTasks();
  const target = tasks.find((item) => String(item.id) === String(taskId));
  if (!target) return null;
  const isCompleting = String(status).toLowerCase() === "completed";
  const completionNotes =
    patch.completionNotes ||
    (isCompleting
      ? [
          patch.findings || target.findings,
          patch.resolution || target.resolution,
          patch.customerAdvice || target.customerAdvice,
        ]
          .filter(Boolean)
          .join(" | ")
      : patch.completionNotes);

  const next = tasks.map((item) =>
    String(item.id) === String(taskId)
      ? normalizeTask({
          ...item,
          ...patch,
          status,
          completionNotes,
          startedAt:
            String(status).toLowerCase() === "in progress"
              ? item.startedAt || new Date().toISOString()
              : item.startedAt || null,
          completedAt:
            String(status).toLowerCase() === "completed"
              ? new Date().toISOString()
              : item.completedAt || null,
          timeline: appendTimeline(
            item,
            createTimelineEvent({
              title: `Status changed to ${status}`,
              description: `Task updated to ${status}.`,
              actor,
            })
          ),
          updatedAt: new Date().toISOString(),
        })
      : item
  );

  const updated = next.find((item) => String(item.id) === String(taskId)) || null;

  if (updated) {
    const token = await api.getStoredToken();
    if (!token) throw new Error("Please sign in again before updating a task.");
    // Send only the fields changed by this action. A completion proof can
    // contain an encoded camera photo; sending the whole normalized task also
    // duplicated that image in afterPhotoUri and made mobile uploads time out.
    const requestPayload = {
      ...patch,
      status,
      completionNotes,
      startedAt: updated.startedAt,
      completedAt: updated.completedAt,
      timeline: updated.timeline,
      updatedAt: updated.updatedAt,
    };
    const result = await api.patchTask(token, taskId, requestPayload);
    if (!result.success) throw new Error(result.error || "Failed to update task.");
    const backendTask = normalizeTask(result.task);
    await saveAllTasks(
      next.map((item) => (String(item.id) === String(taskId) ? backendTask : item)),
    );
    return backendTask;
  }

  await saveAllTasks(next);

  if (updated?.requestId) {
    if (String(status).toLowerCase() === "in progress") {
      await updateServiceRequestStatus(
        updated.requestId,
        SERVICE_REQUEST_STATUS.IN_PROGRESS,
        actor,
        "Technician started working on the service request."
      );
    }

    if (String(status).toLowerCase() === "completed") {
      await updateServiceRequestStatus(
        updated.requestId,
        SERVICE_REQUEST_STATUS.COMPLETED,
        actor,
        "Technician completed the service request."
      );
    }
  }

  return updated;
}

export async function getTasksByTechnician(technicianId) {
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.fetchTasks(token, { technicianId });
      if (result.success) {
        await saveAllTasks(result.tasks);
        return result.tasks.map(normalizeTask);
      }
    }
  } catch {}

  const tasks = await getAllTasks();
  return tasks.filter(
    (item) => String(item.assignedTechnicianId) === String(technicianId)
  );
}

export async function acceptTask(taskId) {
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.acceptTask(token, taskId);
      if (result.success) {
        const accepted = normalizeTask(result.task);
        const tasks = await getAllTasks();
        await saveAllTasks(
          tasks.map((item) => (String(item.id) === String(taskId) ? accepted : item)),
        );
        return accepted;
      }
      throw new Error(result.error || "Failed to accept task.");
    }
  } catch (error) {
    throw error;
  }

  return updateTaskStatus(taskId, TASK_STATUS.ACCEPTED);
}

export async function checkInTask(taskId, coordinates) {
  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again before checking in.");
  const result = await api.checkInTask(token, taskId, coordinates);
  if (!result.success) throw new Error(result.error || "Unable to check in to this work order.");
  const checkedIn = normalizeTask(result.task);
  const tasks = await getAllTasks();
  await saveAllTasks(tasks.map((item) => (String(item.id) === String(taskId) ? checkedIn : item)));
  return checkedIn;
}

export async function confirmInstallationArrival(taskId) {
  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again before validating the arrival.");
  const result = await api.confirmInstallationArrival(token, taskId);
  if (!result.success) throw new Error(result.error || "Unable to confirm customer presence.");
  const updated = normalizeTask(result.task);
  const tasks = await getAllTasks();
  await saveAllTasks(tasks.map((item) => (String(item.id) === String(taskId) ? updated : item)));
  return updated;
}

export async function confirmCodCollection(taskId) {
  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again.");
  const result = await api.confirmCodCollection(token, taskId);
  if (!result.success) throw new Error(result.error);
  return getTaskById(taskId);
}

export async function getVisitAttempt(taskId) {
  const token = await api.getStoredToken();
  if (!token) throw new Error('Please sign in again.');
  return api.getVisitAttempt(token, taskId);
}

export async function submitVisitAttempt(taskId, input) {
  const token = await api.getStoredToken();
  if (!token) throw new Error('Please sign in again.');
  return api.submitVisitAttempt(token, taskId, input);
}

export async function collectServicePayment(taskId, payment) {
  const token = await api.getStoredToken();
  if (!token) throw new Error("Please sign in again.");
  const result = await api.collectServicePayment(token, taskId, payment);
  if (!result.success) throw new Error(result.error);
  return getTaskById(taskId, { requireOnline: true });
}

export async function registerTaskAmpUnit(taskId, payload = {}) {
  const token = await api.getStoredToken();
  if (!token) throw new Error("You need to sign in again before registering this unit.");

  const result = await api.registerAmpUnit(token, taskId, payload);
  if (!result.success) {
    const missing = Array.isArray(result.missingFields) && result.missingFields.length
      ? ` Missing: ${result.missingFields.join(", ")}.`
      : "";
    throw new Error(`${result.error || "Failed to submit AMP registration."}${missing}`);
  }

  const updated = normalizeTask(result.task);
  const tasks = await getAllTasks();
  await saveAllTasks(
    tasks.map((item) => (String(item.id) === String(taskId) ? updated : item)),
  );
  return {
    task: updated,
    registration: result.registration,
    registrationProgress: result.registrationProgress || updated.registrationProgress,
  };
}

export async function reassignTaskTechnician(taskId, technician = {}) {
  const technicianName =
    technician.name ||
    `${technician.name_first || ""} ${technician.name_last || ""}`.trim() ||
    technician.email ||
    "Technician";

  const updated = await updateTask(taskId, {
    assignedTechnicianId: technician.id || "",
    assignedTechnicianName: technicianName,
  });

  if (updated?.requestId) {
    await assignTechnicianToServiceRequest(
      updated.requestId,
      technician.id || "",
      technicianName,
      updated.id,
      "Admin"
    );
  }

  return updated;
}

export function getTaskStats(tasks = []) {
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === TASK_STATUS.PENDING).length,
    inProgress: tasks.filter((task) => task.status === TASK_STATUS.IN_PROGRESS).length,
    completed: tasks.filter((task) => task.status === TASK_STATUS.COMPLETED).length,
    onHold: tasks.filter((task) => task.status === TASK_STATUS.ON_HOLD).length,
    cancelled: tasks.filter((task) => task.status === TASK_STATUS.CANCELLED).length,
  };
}
