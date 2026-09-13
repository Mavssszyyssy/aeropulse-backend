const CONFIRMED_PAYMENT_STATUSES = new Set(["paid", "verified", "completed", "succeeded"]);

const normalizePaymentStatus = (value = "") => String(value || "").trim().toLowerCase();

const resolveOrderPaymentStatus = (order = {}) => {
  const paymentStatus = normalizePaymentStatus(order.paymentStatus);
  const receiptStatus = normalizePaymentStatus(order.receipt?.paymentStatus);
  const orderStatus = normalizePaymentStatus(order.status);

  if (
    CONFIRMED_PAYMENT_STATUSES.has(paymentStatus)
    || CONFIRMED_PAYMENT_STATUSES.has(receiptStatus)
    || CONFIRMED_PAYMENT_STATUSES.has(orderStatus)
    || order.paymongo?.paidAt
    || order.codCollection?.collectedAt
  ) return "paid";

  return paymentStatus || receiptStatus || orderStatus || "pending";
};

const orderIsPaid = (order = {}) => resolveOrderPaymentStatus(order) === "paid";

const buildOrderPaymentSnapshot = (order = {}) => ({
  method: order.paymentMethod || "",
  provider: order.paymentProvider || "",
  status: resolveOrderPaymentStatus(order),
  amount: Number(order.totalAmount || 0),
  paidAt: order.paymongo?.paidAt || order.codCollection?.collectedAt || null,
  reference: order.paymongo?.referenceNumber || order.receipt?.paymentReference || "",
});

module.exports = {
  buildOrderPaymentSnapshot,
  orderIsPaid,
  resolveOrderPaymentStatus,
};
