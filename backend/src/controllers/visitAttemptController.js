const mongoose = require('mongoose');
const Task = require('../models/Task');
const VisitAttempt = require('../models/VisitAttempt');
const ServiceRequest = require('../models/ServiceRequest');
const Order = require('../models/Order');
const { notifyOperationalStaff, createDedupedNotification } = require('../services/operationalNotificationService');
const { awaitingVisitFollowUp, visitAttemptError, nextVisitError } = require('../domain/visitAttempt');
const { buildOrderPaymentSnapshot } = require('../domain/orderPayment');

async function scopedTask(req) {
  const id = String(req.params.taskId || '');
  const identity = [{ taskCode: id }];
  if (mongoose.Types.ObjectId.isValid(id)) identity.push({ _id: id });
  const scope = [{ $or: identity }];
  if (req.authUser.role === 'technician') scope.push({ assignedTechnicianId: String(req.authUser._id) });
  else if (req.authUser.role !== 'superadmin') {
    if (!req.activeBranch) return null;
    scope.push({ branch: req.activeBranch });
  }
  return Task.findOne({ $and: scope });
}

async function linkedInstallationOrder(task) {
  if (task.payload?.requestId) return null;
  const identity = [{ orderCode: task.payload?.orderCode || '__none__' }];
  if (mongoose.Types.ObjectId.isValid(task.payload?.orderId || '')) identity.push({ _id: task.payload.orderId });
  return Order.findOne({ $or: identity });
}

// Idempotent timeline entries and notifications make a network retry safe.
async function syncAttempt(task, attempt, resolved = false) {
  const eventId = `visit:${attempt._id}:${resolved ? 'scheduled' : 'closed'}`;
  const summary = task.payload.visitAttempt;
  const requestId = task.payload?.requestId;
  const request = mongoose.Types.ObjectId.isValid(requestId || '') ? await ServiceRequest.findById(requestId) : null;
  let order = null;
  const installationAttempt = !request && Boolean(task.payload?.orderId || task.payload?.orderCode);
  const title = resolved
    ? installationAttempt ? 'Installation revisit confirmed' : 'Next visit scheduled'
    : installationAttempt
      ? 'Failed to Install — no one available'
      : attempt.outcome === 'reschedule' ? 'Visit rescheduling requested' : 'Visit closed — no one available';
  const description = resolved
    ? installationAttempt
      ? `Next visit: ${task.scheduledDate} · ${task.timeSlot}. The installation has been dispatched for the new visit. A new GPS check-in and customer-presence confirmation are required before installation starts.`
      : `Next visit: ${task.scheduledDate} · ${task.timeSlot}. A new GPS check-in is required.`
    : installationAttempt
      ? `${attempt.note} Installation was not started. ${summary?.nextWorkflowStatus === 'to_dispatch' ? 'This revisit must return to To Dispatch.' : 'Admin must confirm the next schedule.'}`
      : `${attempt.note} Admin will follow up. The request has not been cancelled or completed.`;
  if (request) {
    const timeline = Array.isArray(request.payload?.timeline) ? request.payload.timeline : [];
    if (!timeline.some(item => item.id === eventId)) timeline.push({ id: eventId, title, description, actor: resolved ? 'Admin' : attempt.technicianName, timestamp: new Date().toISOString() });
    request.payload = { ...(request.payload || {}), timeline, visitAttempt: summary, linkedTaskStatus: task.status,
      ...(resolved ? { scheduledDate: task.scheduledDate, timeSlot: task.timeSlot } : {}) };
    await request.save();
  } else {
    order = await linkedInstallationOrder(task);
    if (order) {
      order.visitAttempt = summary;
      if (!Array.isArray(order.fulfillmentTimeline)) order.fulfillmentTimeline = [];
      if (!order.fulfillmentTimeline.some(event => event.stage === eventId)) {
        order.fulfillmentTimeline.push({ stage: eventId, label: title, detail: description, timestamp: new Date() });
      }
      if (resolved) {
        order.workflowStatus = 'to_dispatch';
        order.deliveryStatus = 'dispatched';
        order.installationDate = task.scheduledDate;
        order.estimatedArrival = task.scheduledDate;
        order.installationTimeSlot = task.timeSlot;
      } else {
        order.workflowStatus = summary?.nextWorkflowStatus || 'for_rescheduling';
        order.deliveryStatus = summary?.nextWorkflowStatus === 'to_dispatch' ? 'failed_installation' : 'for_rescheduling';
        order.estimatedArrival = '';
        order.installationDate = '';
        order.installationTimeSlot = '';
      }
      await order.save();
    }
  }
  await notifyOperationalStaff({ branch: task.branch, type: request ? 'service' : order ? 'delivery' : 'technician', category: 'visit_attempt', title,
    message: `${task.taskCode}: ${description}`, targetId: String(request?._id || order?._id || task._id), targetType: request ? 'service_request' : order ? 'order' : 'task',
    route: request ? '/admin/services/service-requests' : order ? '/admin/services/orders' : '/admin/services/technicians', dedupeKey: eventId, dedupeMinutes: 0 });
  await createDedupedNotification({ user: request?.customerId || order?.customer || task.customerId, type: request ? 'service' : 'order', category: 'visit_attempt', title,
    message: description, targetId: String(request?._id || order?._id || task._id), targetType: request ? 'service_request' : 'order', route: request ? '/customer/service-requests' : '/customer/orders', dedupeKey: eventId }, { dedupeMinutes: 0 });
  if (resolved) await createDedupedNotification({ user: task.assignedTechnicianId, type: 'technician', category: 'task', title,
    message: `${task.taskCode}: ${description}`, route: '/technician/tasks', targetId: String(task._id), targetType: 'task', dedupeKey: eventId }, { dedupeMinutes: 0 });
}

async function getVisitAttempt(req, res) {
  try {
    const task = await scopedTask(req);
    if (!task) return res.status(404).json({ message: 'Work order not found.' });
    const attempt = task.payload?.visitAttempt?.id ? await VisitAttempt.findOne({ _id: task.payload.visitAttempt.id, taskId: task._id }) : null;
    return res.json({ attempt });
  } catch { return res.status(500).json({ message: 'Unable to load visit proof.' }); }
}

async function submitVisitAttempt(req, res) {
  try {
    if (req.authUser.role !== 'technician') return res.status(403).json({ message: 'Forbidden' });
    let task = await scopedTask(req);
    if (!task) return res.status(404).json({ message: 'Work order not found.' });
    if (['completed', 'cancelled'].includes(task.status)) return res.status(409).json({ message: 'This work order is closed. No unattended visit can be submitted.' });
    let attempt;
    if (awaitingVisitFollowUp(task)) {
      attempt = await VisitAttempt.findOne({ _id: task.payload.visitAttempt.id, taskId: task._id, technicianId: String(req.authUser._id) });
      if (!attempt) return res.status(409).json({ message: 'This visit is already closed.' });
      if (req.body?.checkedInAt !== attempt.checkedInAt) return res.status(409).json({ message: 'This is a different visit attempt. Refresh the work order.' });
    } else {
      const error = visitAttemptError(task, req.body);
      if (error) return res.status(400).json({ message: error });
      const checkIn = task.payload.checkIn;
      const previousAttempt = task.payload?.visitAttempt || null;
      attempt = await VisitAttempt.findOneAndUpdate({ taskId: task._id, checkedInAt: checkIn.checkedInAt }, { $setOnInsert: {
        taskId: task._id, checkedInAt: checkIn.checkedInAt, checkIn, technicianId: String(req.authUser._id),
        technicianName: task.assignedTechnicianName, outcome: req.body.outcome, note: req.body.note.trim(), photo: { uri: req.body.photo.uri },
      } }, { upsert: true, new: true, runValidators: true });
      const order = await linkedInstallationOrder(task);
      const attemptCount = Number(previousAttempt?.attemptNumber || 0) + 1;
      const isRevisitFailure = Boolean(previousAttempt?.resolution) || attemptCount > 1;
      const payment = order ? buildOrderPaymentSnapshot(order) : null;
      const summary = {
        id: String(attempt._id), outcome: attempt.outcome, note: attempt.note,
        submittedAt: attempt.submittedAt, awaitingAdmin: true, attemptNumber: attemptCount,
        installationFailed: Boolean(order),
        nextWorkflowStatus: order ? (isRevisitFailure ? 'to_dispatch' : 'for_rescheduling') : '',
        payment,
      };
      task = await Task.findOneAndUpdate({ _id: task._id, status: 'in-progress', assignedTechnicianId: String(req.authUser._id), 'payload.checkIn.checkedInAt': checkIn.checkedInAt },
        { $set: { status: 'on-hold', 'payload.status': 'on-hold', 'payload.visitAttempt': summary, 'payload.failedInstallation': order ? summary : null, 'payload.checkIn': null, 'payload.arrivalValidation': null, 'payload.installationStartedAt': null } }, { new: true });
      if (!task) return res.status(409).json({ message: 'The work order changed. Reopen it to check the latest visit status.' });
    }
    await syncAttempt(task, attempt);
    return res.json({ success: true, attempt });
  } catch { return res.status(500).json({ message: 'Unable to finish saving this visit. Please retry; the same arrival will not be duplicated.' }); }
}

async function scheduleNextVisit(req, res) {
  try {
    if (!['admin', 'superadmin'].includes(req.authUser.role)) return res.status(403).json({ message: 'Forbidden' });
    let task = await scopedTask(req);
    if (!task) return res.status(404).json({ message: 'Work order not found.' });
    if (['completed', 'cancelled'].includes(task.status)) return res.status(409).json({ message: 'This work order is closed and cannot be rescheduled.' });
    const error = nextVisitError(req.body);
    if (error) return res.status(400).json({ message: error });
    if (typeof req.body.attemptId !== 'string' || !mongoose.Types.ObjectId.isValid(req.body.attemptId)) return res.status(400).json({ message: 'Choose a valid visit attempt.' });
    const attempt = await VisitAttempt.findOne({ _id: req.body.attemptId, taskId: task._id });
    if (!attempt || String(task.payload?.visitAttempt?.id) !== String(attempt._id)) return res.status(409).json({ message: 'Refresh the work order before scheduling this visit.' });
    const resolution = { scheduledDate: req.body.scheduledDate, timeSlot: req.body.timeSlot, confirmedAt: new Date().toISOString(), confirmedBy: String(req.authUser._id) };
    if (!awaitingVisitFollowUp(task)) {
      if (task.scheduledDate !== resolution.scheduledDate || task.timeSlot !== resolution.timeSlot) return res.status(409).json({ message: 'This visit has already been scheduled. Refresh the work order.' });
    } else {
      if (['completed', 'cancelled'].includes(task.status)) return res.status(409).json({ message: 'This work order is closed and cannot be rescheduled.' });
      task = await Task.findOneAndUpdate({ _id: task._id, status: 'on-hold', 'payload.visitAttempt.id': String(attempt._id), 'payload.visitAttempt.awaitingAdmin': true }, { $set: {
        status: 'in-progress', scheduledDate: resolution.scheduledDate, timeSlot: resolution.timeSlot,
        'payload.status': 'in-progress', 'payload.scheduledDate': resolution.scheduledDate, 'payload.timeSlot': resolution.timeSlot,
        'payload.checkIn': null, 'payload.arrivalValidation': null, 'payload.installationStartedAt': null, 'payload.visitAttempt.awaitingAdmin': false, 'payload.visitAttempt.resolution': resolution,
      } }, { new: true });
      if (!task) return res.status(409).json({ message: 'The work order changed. Refresh before trying again.' });
    }
    attempt.resolution = task.payload.visitAttempt.resolution;
    await attempt.save();
    await syncAttempt(task, attempt, true);
    return res.json({ success: true });
  } catch { return res.status(500).json({ message: 'Unable to finish confirming the next visit. Please retry.' }); }
}

module.exports = { getVisitAttempt, submitVisitAttempt, scheduleNextVisit };
