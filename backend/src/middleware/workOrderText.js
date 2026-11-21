const { limitTextFields, textFieldError } = require("./limitTextFields");
const { validateHumanText, validateTextRequest } = require("../domain/textFieldValidation");

const workOrderText = limitTextFields({
  title: [160, "Work order title"],
  address: [240, "Service address"],
  description: [1000, "Instructions"],
  concern: [1000, "Service concern"],
  "schedule.notes": [1000, "Schedule note"],
});

// Mobile combines preset entries and up to 1,000 characters of “Other” text.
const serviceLogFields = {
  findings: [1500, "Findings"],
  resolution: [1500, "Resolution"],
  partsUsed: [1500, "Parts Used"],
  notes: [1000, "Notes"],
};
const serviceReportText = limitTextFields({
  ...serviceLogFields,
  beforeCondition: [1000, "Before condition"],
  afterCondition: [1000, "After condition"],
  serviceActions: [2500, "Service actions", true],
  proofNotes: [1500, "Proof notes"],
  "proof.notes": [1500, "Proof notes"],
  customerAdvice: [1000, "Customer advice"],
  completionNotes: [1000, "Completion notes"],
  failureReason: [500, "Failure reason"],
  rescheduleReason: [500, "Reschedule reason"],
  holdReason: [500, "Hold reason"],
  defectReason: [500, "Defect reason"],
});

function changedServiceLogTextError(incoming, stored) {
  if (!Array.isArray(incoming)) return "";
  const previousById = new Map((Array.isArray(stored) ? stored : []).filter(log => log?.id).map(log => [String(log.id), log]));
  for (const log of incoming) {
    const previous = log?.id ? previousById.get(String(log.id)) : undefined;
    for (const [field, [max, label]] of Object.entries(serviceLogFields)) {
      if (log?.[field] === previous?.[field]) continue;
      const error = textFieldError(log?.[field], max, label) || validateHumanText(log?.[field], { max, label });
      if (error) return error;
    }
    const changed = Object.fromEntries(Object.entries(log || {}).filter(([field, value]) => value !== previous?.[field]));
    const validation = validateTextRequest("/tasks/service-note", "PATCH", changed);
    if (validation) return validation.message;
  }
  return "";
}

module.exports = { workOrderText, serviceReportText, changedServiceLogTextError };
