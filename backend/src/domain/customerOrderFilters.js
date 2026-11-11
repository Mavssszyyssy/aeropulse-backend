const ORDER_STAGES = new Set(["to_pay", "to_deliver", "to_dispatch", "to_install", "for_rescheduling", "complete", "cancelled"]);
const PAYMENT_STATES = new Set(["pending", "paid", "failed", "cancelled", "expired", "not_required"]);
const DATE_RANGES = { "30d": 30, "90d": 90 };

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildCustomerOrderFilter(customerId, query = {}, now = new Date()) {
  const filter = { customer: customerId };
  const combinedConditions = [];
  const stage = String(query.orderStatus || "").toLowerCase();
  const payment = String(query.paymentStatus || "").toLowerCase();
  const search = String(query.search || "").trim();
  if (ORDER_STAGES.has(stage)) filter.workflowStatus = stage;
  if (PAYMENT_STATES.has(payment) && payment === "cancelled") {
    combinedConditions.push({
      $or: [
        { paymentStatus: "cancelled" },
        {
          workflowStatus: "cancelled",
          paymentStatus: { $nin: ["paid", "verified", "completed", "succeeded"] },
          "paymongo.paidAt": { $exists: false },
          "codCollection.collectedAt": { $exists: false },
        },
      ],
    });
  } else if (PAYMENT_STATES.has(payment)) {
    filter.paymentStatus = payment;
  }
  if (DATE_RANGES[query.dateRange]) {
    filter.createdAt = { $gte: new Date(now.getTime() - DATE_RANGES[query.dateRange] * 24 * 60 * 60 * 1000) };
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search.slice(0, 80)), "i");
    combinedConditions.push({
      $or: [
        { orderCode: pattern },
        { "items.name": pattern },
        { "items.model": pattern },
        { "items.sku": pattern },
        { "items.serialNumbers": pattern },
        { "items.serialUnits.serialNumber": pattern },
        { "items.serialUnits.qrCode": pattern },
      ],
    });
  }
  if (combinedConditions.length) filter.$and = combinedConditions;
  return filter;
}

module.exports = { buildCustomerOrderFilter };
