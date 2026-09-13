const crypto = require("node:crypto");
const { isValidObjectId } = require("mongoose");
const ServiceRequest = require("../models/ServiceRequest");
const Task = require("../models/Task");
const { servicePaymentSummary, servicePaymentRecord } = require("../domain/servicePayment");
const { notifyOperationalStaff, createDedupedNotification } = require("../services/operationalNotificationService");
const { hasVerifiedTaskCheckIn } = require("../domain/taskWorkflow");

const notifyPayment = async (request, event) => {
  const payment = servicePaymentSummary(request);
  const details = { title: `Service payment ${event}`, message: `Service for ${request.unitName || "AC unit"}: PHP ${payment.amount.toFixed(2)} ${event}.`, type: "service", category: "service_request", targetType: "service_request", targetId: String(request._id), dedupeKey: `service-payment:${request._id}:${event}:${payment.quoteId}`, dedupeMinutes: 0 };
  // Notification failure must not roll back an already recorded quote/collection.
  try {
    await notifyOperationalStaff({ ...details, branch: request.branch });
    if (request.customerId) await createDedupedNotification({ ...details, user: request.customerId }, { dedupeMinutes: 0 });
  } catch (error) { console.error("Service payment notification failed", error.message); }
};

const setServiceQuote = async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid service request ID." });
  const request = await ServiceRequest.findById(req.params.id);
  if (!request || (req.authUser.role === "admin" && request.branch !== req.activeBranch)) return res.status(404).json({ message: "Service request not found." });
  if (["Completed", "Cancelled"].includes(request.status) || request.servicePayment?.collectedAt) return res.status(409).json({ message: "Closed or paid service requests cannot be repriced." });
  if (request.payload?.warrantyClaimId) return res.status(409).json({ message: "Approved warranty service is covered; do not add a cash charge to this claim." });
  const raw = req.body?.amount;
  const amount = Number(raw);
  if (!["number", "string"].includes(typeof raw) || String(raw).trim() === "" || !Number.isFinite(amount) || amount < 0 || amount > 1000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) return res.status(400).json({ message: "Enter a non-negative PHP quote with at most two decimal places." });
  const linkedTaskId = request.payload?.linkedTaskId;
  const linkedTask = linkedTaskId && isValidObjectId(linkedTaskId)
    ? await Task.findById(linkedTaskId).select("payload")
    : null;
  const paymentRecord = servicePaymentRecord(request, linkedTask?.payload || {}, { baseAmount: amount, quoteId: crypto.randomUUID(), quotedAt: new Date(), quotedBy: String(req.authUser._id) });
  const saved = await ServiceRequest.findOneAndUpdate({ _id: request._id, updatedAt: request.updatedAt, "servicePayment.collectedAt": null, status: { $nin: ["Completed", "Cancelled"] } }, { $set: { servicePayment: paymentRecord } }, { returnDocument: "after" });
  if (!saved) return res.status(409).json({ message: "This request changed. Refresh before setting the quote." });
  await notifyPayment(saved, "quoted");
  return res.json({ servicePayment: servicePaymentSummary(saved) });
};

const collectServicePayment = async (req, res) => {
  if (!isValidObjectId(req.params.taskId)) return res.status(400).json({ message: "Invalid work order ID." });
  const task = await Task.findOne({ _id: req.params.taskId, assignedTechnicianId: String(req.authUser._id) });
  if (!task) return res.status(404).json({ message: "Assigned task not found." });
  const request = task.payload?.requestId ? await ServiceRequest.findById(task.payload.requestId) : null;
  if (!request || String(request.payload?.linkedTaskId) !== String(task._id) || String(request.assignedTechnicianId) !== String(req.authUser._id)) return res.status(409).json({ message: "The service assignment has changed. Refresh the work order." });
  if (["Completed", "Cancelled"].includes(request.status) || ["completed", "cancelled", "pending", "on-hold", "failed", "rescheduled"].includes(task.status)) return res.status(409).json({ message: "Only an active service visit can collect payment." });
  if (!hasVerifiedTaskCheckIn(task)) return res.status(409).json({ message: "Check in at the service location before confirming cash collection." });
  const payment = servicePaymentSummary(request);
  if (payment.status === "paid") return res.json({ servicePayment: payment });
  if (payment.status !== "due") return res.status(409).json({ message: payment.status === "quote_required" ? "Admin must set the service quote first." : "No cash collection is required for this service." });
  if (!Array.isArray(task.payload?.serviceLogs) || task.payload.serviceLogs.length === 0) return res.status(409).json({ message: "Save the technician service note and any labor or parts costs before collecting payment." });
  if (req.body?.confirmed !== true || req.body?.amount !== payment.amount || req.body?.quoteId !== payment.quoteId) return res.status(409).json({ message: "Confirm the current full service amount. Refresh if the quote changed." });
  const saved = await ServiceRequest.findOneAndUpdate({ _id: request._id, updatedAt: request.updatedAt, assignedTechnicianId: String(req.authUser._id), "servicePayment.collectedAt": null, status: "In Progress" }, { $set: { servicePayment: { ...(request.servicePayment || {}), amount: payment.amount, quoteId: payment.quoteId, collectedAt: new Date(), collectedBy: String(req.authUser._id), taskId: String(task._id), method: "cash" } } }, { returnDocument: "after" });
  if (!saved) return res.status(409).json({ message: "Service details changed. Refresh before confirming collection." });
  await notifyPayment(saved, "collected");
  return res.json({ servicePayment: servicePaymentSummary(saved) });
};
module.exports = { setServiceQuote, collectServicePayment };
