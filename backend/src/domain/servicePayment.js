const servicePaymentSummary = (request) => {
  if (!request) return null;
  const saved = request.servicePayment || {};
  const warrantyCovered = Boolean(request.payload?.warrantyClaimId);
  const rawBase = saved.baseAmount ?? saved.amount ?? request.payload?.pricing?.basePrice;
  const baseAmount = warrantyCovered ? 0 : rawBase === null || rawBase === undefined || rawBase === "" ? null : Number(rawBase);
  const validBaseAmount = Number.isFinite(baseAmount) && baseAmount >= 0 ? baseAmount : null;
  const laborCost = Number.isFinite(Number(saved.laborCost)) && Number(saved.laborCost) >= 0 ? Number(saved.laborCost) : 0;
  const partsCost = Number.isFinite(Number(saved.partsCost)) && Number(saved.partsCost) >= 0 ? Number(saved.partsCost) : 0;
  const validAmount = warrantyCovered ? 0 : validBaseAmount === null ? null : Math.round((validBaseAmount + laborCost + partsCost) * 100) / 100;
  return {
    amount: validAmount, baseAmount: validBaseAmount, laborCost, partsCost, currency: "PHP", method: "cash",
    status: warrantyCovered ? "warranty_covered" : saved.collectedAt ? "paid" : validAmount === null ? "quote_required" : validAmount === 0 ? "no_charge" : "due",
    collectedAt: saved.collectedAt || null, collectedBy: saved.collectedBy || "",
    quotedAt: saved.quotedAt || null, quoteId: saved.quoteId || "catalog",
  };
};

const servicePaymentRecord = (request, taskPayload = {}, overrides = {}) => {
  const saved = request?.servicePayment || {};
  const rawBase = overrides.baseAmount ?? saved.baseAmount ?? saved.amount ?? request?.payload?.pricing?.basePrice;
  const baseAmount = rawBase === null || rawBase === undefined || rawBase === "" ? null : Number(rawBase);
  const laborCost = taskPayload.laborCost === null || taskPayload.laborCost === undefined ? 0 : Number(taskPayload.laborCost);
  const partsCost = taskPayload.partsCost === null || taskPayload.partsCost === undefined ? 0 : Number(taskPayload.partsCost);
  const validBase = Number.isFinite(baseAmount) && baseAmount >= 0 ? baseAmount : null;
  return {
    ...saved,
    ...overrides,
    baseAmount: validBase,
    laborCost: Number.isFinite(laborCost) && laborCost >= 0 ? laborCost : 0,
    partsCost: Number.isFinite(partsCost) && partsCost >= 0 ? partsCost : 0,
    amount: validBase === null ? null : Math.round((validBase + (Number.isFinite(laborCost) ? laborCost : 0) + (Number.isFinite(partsCost) ? partsCost : 0)) * 100) / 100,
  };
};
const servicePaymentBlocker = (request) => {
  const payment = servicePaymentSummary(request);
  if (!payment) return "The linked service request could not be found.";
  if (payment.status === "quote_required") return "Admin must set the service quote before this visit can be completed.";
  if (payment.status === "due") return "Confirm the service cash payment after collecting it before completing this visit.";
  return "";
};
module.exports = { servicePaymentSummary, servicePaymentBlocker, servicePaymentRecord };
