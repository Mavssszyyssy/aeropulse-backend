const cleanText = (value, maxLength = 500) => String(value || "").trim().slice(0, maxLength);

const uniqueText = (values = []) => Array.from(new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 100))
    .filter(Boolean),
));

const normalizeTaskSchedule = (input = {}, team = []) => ({
  driverName: cleanText(input.driverName, 120),
  teamMemberIds: uniqueText(team.map((member) => member.id || member._id)),
  teamMemberNames: uniqueText(team.map((member) => member.name)),
  notes: cleanText(input.notes, 1000),
});

const paymentLabel = (method = "") => {
  const value = cleanText(method, 50).toLowerCase();
  if (!value) return "";
  if (value === "cod") return "Cash on delivery";
  if (value === "gcash") return "GCash";
  if (value === "card") return "Card";
  return cleanText(method, 50);
};

const serviceCategory = (task = {}) => {
  const payload = task.payload || {};
  if (payload.orderId || task.orderId || payload.orderCode || task.orderCode) return "installation";
  const text = [payload.serviceType, task.issueType, task.title].filter(Boolean).join(" ").toLowerCase();
  if (/deep\s*clean/.test(text)) return "deep_cleaning";
  if (/clean/.test(text)) return "regular_cleaning";
  return "service_checkup";
};

const summarizeItems = (items = []) => (Array.isArray(items) ? items : [])
  .map((item) => {
    const name = cleanText(item?.name || item?.model || item?.sku, 140);
    const quantity = Number(item?.quantity || 0);
    return name ? `${quantity > 1 ? `${quantity} × ` : ""}${name}` : "";
  })
  .filter(Boolean)
  .join(", ");

const buildTaskScheduleDetails = (task = {}, { order = null, serviceRequest = null } = {}) => {
  const payload = task.payload || {};
  const category = serviceCategory(task);
  const items = order?.items || payload.items || [];
  const servicePayment = serviceRequest?.servicePayment || {};
  const paymentMethod = order?.paymentMethod || servicePayment.method || "";
  const paymentStatus = order?.paymentStatus || servicePayment.status || "";
  const additionalCost = payload.additionalCost;
  const recordedCost = additionalCost === null || additionalCost === undefined || additionalCost === ""
    ? null
    : Number(additionalCost);

  return {
    reference: cleanText(order?.orderCode || payload.orderCode || task.taskCode, 100),
    category,
    workDescription: category === "installation"
      ? summarizeItems(items) || cleanText(task.unitName || task.title, 500)
      : cleanText(payload.serviceType || task.issueType || task.title, 500),
    paymentMethod: paymentLabel(paymentMethod),
    paymentStatus: cleanText(paymentStatus, 50),
    otherExpenses: Number.isFinite(recordedCost) && recordedCost >= 0 ? recordedCost : null,
    sellerPersonnel: cleanText(payload.sellerName || payload.personnelName || payload.processedByName, 120),
  };
};

module.exports = { buildTaskScheduleDetails, normalizeTaskSchedule, serviceCategory };
