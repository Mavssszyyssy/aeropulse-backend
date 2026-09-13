const isCodOrder = (order = {}) => /^(cod|cash on delivery)$/i.test(String(order.paymentMethod || "").trim());
const hasCodCollection = (order = {}) => Boolean(order.codCollection?.collectedAt && order.codCollection?.technicianId);
const codCollectionBlocker = (order, task, technicianId) => {
  if (!order || !isCodOrder(order)) return "This work order does not have a cash-on-delivery payment.";
  if (String(task.assignedTechnicianId) !== String(technicianId) || String(order.assignedTechnicianId) !== String(technicianId)) return "Only the assigned technician can confirm cash collection.";
  if (!["to_dispatch", "to_install"].includes(order.workflowStatus) || order.deliveryStatus === "failed_installation" || !order.dispatchedAt) return "The order must be dispatched before cash collection.";
  if (!["in-progress", "arrived", "installing"].includes(task.status)) return "This work order must be active before cash collection.";
  if (!task.payload?.checkIn?.checkedInAt) return "Check in at the customer location before confirming cash collection.";
  return null;
};
module.exports = { isCodOrder, hasCodCollection, codCollectionBlocker };
