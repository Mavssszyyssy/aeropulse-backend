const mongoose = require("mongoose");
const ServiceRequest = require("../models/ServiceRequest");
const ServiceHistory = require("../models/ServiceHistory");
const Task = require("../models/Task");
const Unit = require("../models/Unit");
const { generateMaintenanceAssessment } = require("../services/maintenanceDecisionAiService");

const clean = (value, max = 500) => String(value || "").trim().slice(0, max);
const id = (value) => mongoose.isValidObjectId(value) ? String(value) : "";
const evidenceEntry = (key, label, value) => value ? { id: key, label, text: clean(value) } : null;
const requestIssue = (request) => clean(request?.payload?.concern || request?.payload?.issueDescription || request?.issue, 900);
const hasSufficientPostEvidence = (history) => [history?.findings, history?.actionTaken]
  .map((part) => clean(part)).join(" ").replace(/\s/g, "").length >= 18;
const unitFor = async (unitId) => id(unitId) ? Unit.findById(unitId).lean() : null;
const priorVisits = async (unitId, excluding = "") => unitId
  ? ServiceHistory.find({ unit: unitId, ...(excluding ? { _id: { $ne: excluding } } : {}) })
    .select("serviceDate serviceType findings actionTaken partsUsed technicianInputs.notes")
    .sort({ serviceDate: -1 }).limit(5).lean()
  : [];

function buildEvidence({ kind, request, task, unit, history, prior = [] }) {
  const evidence = [];
  const add = (key, label, value) => { const item = evidenceEntry(key, label, value); if (item) evidence.push(item); };
  add("equipment", "Registered AC equipment", [unit?.brand, unit?.modelName, unit?.category, unit?.capacityHp ? `${unit.capacityHp} HP` : ""].filter(Boolean).join(" · ") || request?.unitName || task?.unitName);
  add("reported_issue", "Customer-reported concern (unverified)", requestIssue(request) || task?.description || history?.customerInputs?.reportedIssue);
  if (kind === "post") {
    add("current_findings", "Latest technician findings (original wording)", history?.findings);
    add("current_notes", "Latest technician notes (original wording)", history?.technicianInputs?.notes && history.technicianInputs.notes !== history.findings ? history.technicianInputs.notes : "");
    add("work_performed", "Work performed on this visit", history?.actionTaken);
    add("parts_used", "Parts recorded as used on this visit", (history?.partsUsed || []).join(", "));
    add("condition", "Technician condition rating", history?.conditionRating);
    add("technician_status", "Technician visit status", history?.technicianStatus);
  }
  prior.forEach((visit, index) => {
    const details = [visit.serviceDate ? new Date(visit.serviceDate).toISOString().slice(0, 10) : "", visit.serviceType,
      visit.findings || visit.technicianInputs?.notes, visit.actionTaken,
      (visit.partsUsed || []).length ? `Parts used: ${visit.partsUsed.join(", ")}` : ""].filter(Boolean).join(" · ");
    add(`prior_visit_${index + 1}`, "Earlier visit for this AC unit", details);
  });
  return evidence;
}

function permittedBranch(req, branch) {
  return req.authUser.role === "superadmin" || (req.activeBranch && (!branch || branch === req.activeBranch));
}
async function findRequest(req, requestId) {
  if (!id(requestId)) return null;
  const request = await ServiceRequest.findById(requestId);
  return request && permittedBranch(req, request.branch) ? request : null;
}
async function findTask(req) {
  const taskId = clean(req.params.taskId, 100);
  const conditions = [{ taskCode: taskId }];
  if (id(taskId)) conditions.push({ _id: taskId });
  const task = await Task.findOne({ $or: conditions });
  if (!task || !permittedBranch(req, task.branch)) return null;
  if (req.authUser.role === "technician") {
    const actor = String(req.authUser._id);
    if (String(task.assignedTechnicianId) !== actor && !(task.schedule?.teamMemberIds || []).includes(actor)) return null;
  }
  return task;
}

async function makePreAssessment(req, res, request) {
  if (["Cancelled", "Completed"].includes(request.status)) return res.status(409).json({ message: "A pre-visit assessment requires an open service request." });
  const unit = await unitFor(request.unitId);
  if (unit && !permittedBranch(req, unit.serviceBranch)) return res.status(403).json({ message: "This AC unit belongs to another branch." });
  const evidence = buildEvidence({ kind: "pre", request, unit, prior: await priorVisits(unit?._id) });
  if (!requestIssue(request) || requestIssue(request).length < 10) return res.status(422).json({ message: "Add more detail about the reported symptoms before generating an AI assessment." });
  const result = await generateMaintenanceAssessment({ kind: "pre", evidence, actorId: req.authUser._id });
  const saved = { ...result, evidence, review: { decision: "pending", by: "", at: null } };
  await ServiceRequest.updateOne({ _id: request._id }, { $set: { aiPreAssessment: saved } });
  return res.status(result.status === "completed" ? 200 : 503).json({ preAssessment: saved, message: result.error || "Pre-maintenance assessment saved." });
}

const generateRequestPreAssessment = async (req, res) => {
  try {
    const request = await findRequest(req, req.params.requestId);
    if (!request) return res.status(404).json({ message: "Service request not found." });
    return makePreAssessment(req, res, request);
  } catch (error) { console.error("Pre-maintenance assessment failed", error); return res.status(500).json({ message: "Unable to generate the assessment." }); }
};

const generateTaskPreAssessment = async (req, res) => {
  try {
    const task = await findTask(req);
    if (!task) return res.status(404).json({ message: "Work order not found." });
    const request = await findRequest(req, task.payload?.requestId);
    if (!request) return res.status(409).json({ message: "This work order has no linked service request." });
    return makePreAssessment(req, res, request);
  } catch (error) { console.error("Task pre-maintenance assessment failed", error); return res.status(500).json({ message: "Unable to generate the assessment." }); }
};

const getTaskDecisionSupport = async (req, res) => {
  try {
    const task = await findTask(req);
    if (!task) return res.status(404).json({ message: "Work order not found." });
    const request = await findRequest(req, task.payload?.requestId);
    const history = await ServiceHistory.findOne({ sourceTaskId: String(task._id) }).lean();
    return res.json({ preAssessment: request?.aiPreAssessment || null, futurePrediction: history?.aiFuturePrediction || null,
      canGeneratePre: Boolean(request && !["Cancelled", "Completed"].includes(request.status)),
      canGeneratePost: task.status === "completed" && Boolean(history),
      serviceHistoryId: history ? String(history._id) : "" });
  } catch (error) { console.error("Decision support load failed", error); return res.status(500).json({ message: "Unable to load AI decision support." }); }
};

const generateFuturePrediction = async (req, res) => {
  try {
    const task = await findTask(req);
    if (!task) return res.status(404).json({ message: "Work order not found." });
    if (task.status !== "completed") return res.status(409).json({ message: "Complete and save the technician report before predicting future issues." });
    const history = await ServiceHistory.findOne({ sourceTaskId: String(task._id) });
    if (!history) return res.status(409).json({ message: "No completed AC maintenance record is linked to this work order." });
    const unit = await unitFor(history.unit);
    if (!unit || !permittedBranch(req, unit.serviceBranch)) return res.status(403).json({ message: "AC unit not available for this branch." });
    const request = await findRequest(req, task.payload?.requestId);
    const evidence = buildEvidence({ kind: "post", task, request, unit, history, prior: await priorVisits(unit._id, history._id) });
    if (!hasSufficientPostEvidence(history)) {
      const saved = { status: "insufficient", error: "The completed findings need more diagnostic detail for a reliable future-issue assessment.", evidence, generatedAt: new Date() };
      await ServiceHistory.updateOne({ _id: history._id }, { $set: { aiFuturePrediction: saved } });
      return res.status(422).json({ futurePrediction: saved, message: saved.error });
    }
    const result = await generateMaintenanceAssessment({ kind: "post", evidence, actorId: req.authUser._id });
    const saved = { ...result, evidence, review: { decision: "pending", by: "", at: null } };
    await ServiceHistory.updateOne({ _id: history._id }, { $set: { aiFuturePrediction: saved } });
    return res.status(result.status === "completed" ? 200 : 503).json({ futurePrediction: saved, message: result.error || "Future-issue assessment saved." });
  } catch (error) { console.error("Future-issue assessment failed", error); return res.status(500).json({ message: "Unable to generate the prediction." }); }
};

const reviewDecisionSupport = async (req, res) => {
  try {
    if (req.authUser.role !== "technician") return res.status(403).json({ message: "Technician review is required." });
    const task = await findTask(req);
    if (!task || String(task.assignedTechnicianId) !== String(req.authUser._id)) return res.status(404).json({ message: "Assigned work order not found." });
    const phase = req.params.phase;
    const decision = clean(req.body?.decision, 20).toLowerCase();
    if (!["pre", "post"].includes(phase) || !["confirmed", "rejected"].includes(decision)) return res.status(400).json({ message: "Choose a valid assessment and review decision." });
    const request = phase === "pre" ? await findRequest(req, task.payload?.requestId) : null;
    const history = phase === "post" ? await ServiceHistory.findOne({ sourceTaskId: String(task._id) }) : null;
    const current = phase === "pre" ? request?.aiPreAssessment : history?.aiFuturePrediction;
    if (current?.status !== "completed") return res.status(409).json({ message: "There is no completed AI assessment to review." });
    const reviewed = { ...current, review: { decision, by: String(req.authUser._id), at: new Date(), note: clean(req.body?.note, 500) } };
    if (phase === "pre") await ServiceRequest.updateOne({ _id: request._id }, { $set: { aiPreAssessment: reviewed } });
    else await ServiceHistory.updateOne({ _id: history._id }, { $set: { aiFuturePrediction: reviewed } });
    return res.json({ assessment: reviewed });
  } catch (error) { console.error("AI assessment review failed", error); return res.status(500).json({ message: "Unable to save technician review." }); }
};

module.exports = { buildEvidence, hasSufficientPostEvidence, generateRequestPreAssessment, generateTaskPreAssessment,
  getTaskDecisionSupport, generateFuturePrediction, reviewDecisionSupport };
