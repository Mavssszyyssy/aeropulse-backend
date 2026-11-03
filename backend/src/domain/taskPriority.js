const TASK_PRIORITIES = Object.freeze(["urgent", "high", "medium", "normal", "low"]);

const parseTaskPriority = (value) => {
  const priority = String(value ?? "").trim().toLowerCase();
  return TASK_PRIORITIES.includes(priority) ? priority : null;
};

module.exports = { TASK_PRIORITIES, parseTaskPriority };
