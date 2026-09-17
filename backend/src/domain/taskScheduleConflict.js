const mongoose = require("mongoose");
const Task = require("../models/Task");

const NON_BLOCKING_STATUSES = ["completed", "cancelled", "failed", "rescheduled"];

const normalizeIdList = (values = []) => Array.from(new Set(
  (Array.isArray(values) ? values : [values])
    .map((value) => String(value || "").trim())
    .filter(Boolean),
));

const parseClockMinutes = (value = "") => {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return (hour * 60) + minute;
};

const parseTimeSlot = (value = "") => {
  const parts = String(value).trim().split(/\s*(?:–|—|-)\s*/);
  if (parts.length !== 2) return null;
  const start = parseClockMinutes(parts[0]);
  const end = parseClockMinutes(parts[1]);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
};

const timeSlotsOverlap = (left, right) => {
  const first = typeof left === "string" ? parseTimeSlot(left) : left;
  const second = typeof right === "string" ? parseTimeSlot(right) : right;
  return Boolean(first && second && first.start < second.end && second.start < first.end);
};

const taskParticipantIds = (task = {}) => normalizeIdList([
  task.assignedTechnicianId,
  ...(task.schedule?.teamMemberIds || []),
]);

const findTaskScheduleConflicts = async ({
  scheduledDate,
  timeSlot,
  participantIds,
  excludeTaskId = "",
} = {}) => {
  const participants = normalizeIdList(participantIds);
  const requestedWindow = parseTimeSlot(timeSlot);
  if (!scheduledDate || !requestedWindow || participants.length === 0) return [];

  const query = {
    scheduledDate: String(scheduledDate),
    status: { $nin: NON_BLOCKING_STATUSES },
    $or: [
      { assignedTechnicianId: { $in: participants } },
      { "schedule.teamMemberIds": { $in: participants } },
    ],
  };
  if (excludeTaskId && mongoose.Types.ObjectId.isValid(String(excludeTaskId))) {
    query._id = { $ne: excludeTaskId };
  }

  const tasks = await Task.find(query)
    .select("taskCode title scheduledDate timeSlot assignedTechnicianId assignedTechnicianName schedule status")
    .lean();

  return tasks.filter((task) => timeSlotsOverlap(requestedWindow, task.timeSlot)).map((task) => ({
    taskId: String(task._id || task.id || ""),
    taskCode: task.taskCode || "Work order",
    timeSlot: task.timeSlot,
    participantIds: taskParticipantIds(task).filter((id) => participants.includes(id)),
  }));
};

const assertNoTaskScheduleConflict = async (input = {}) => {
  const conflicts = await findTaskScheduleConflicts(input);
  if (!conflicts.length) return;
  const first = conflicts[0];
  const error = new Error(
    `The selected technician or team member is already assigned to ${first.taskCode} during ${first.timeSlot}. Choose another available time or person.`,
  );
  error.status = 409;
  error.statusCode = 409;
  error.conflicts = conflicts;
  throw error;
};

module.exports = {
  NON_BLOCKING_STATUSES,
  assertNoTaskScheduleConflict,
  findTaskScheduleConflicts,
  parseTimeSlot,
  taskParticipantIds,
  timeSlotsOverlap,
};
