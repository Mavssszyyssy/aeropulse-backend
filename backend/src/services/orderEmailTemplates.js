const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const money = (amount) => `PHP ${Number(amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const paymentMethods = { cod: "Cash on Delivery", gcash: "GCash", maya: "Maya", credit: "Credit / debit card", card: "Credit / debit card" };

const orderEmail = ({ order, title, introduction, paymentLine, isPaid = false }) => {
  const items = Array.isArray(order.items) ? order.items : [];
  const recipient = String(order.address?.name || order.customerName || "").trim();
  const delivery = [order.address?.street, order.address?.barangay, order.address?.city, order.address?.province, order.address?.postalCode].filter(Boolean).join(", ");
  const paymentMethodKey = String(order.paymentMethod || "").toLowerCase();
  const isCashOnDelivery = paymentMethodKey === "cod";
  const paymentMethod = paymentMethods[paymentMethodKey] || String(order.paymentMethod || "");
  const paidAt = order.paymongo?.paidAt || order.receipt?.issuedAt;
  const paidDate = paidAt && !Number.isNaN(new Date(paidAt).getTime()) ? new Date(paidAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : "";
  const paymentStatus = isPaid ? "Paid" : isCashOnDelivery ? "To be paid on delivery" : "Payment pending";
  const paymentReference = isPaid
    ? String(order.receipt?.paymentReference || order.paymongo?.paymentId || order.paymongo?.paymentIntentId || "").trim()
    : "";
  const itemSubtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
  const subtotal = Number(order.subtotalAmount || order.receipt?.subtotalAmount || itemSubtotal);
  const vat = Number(order.vatAmount || order.receipt?.vatAmount || 0);
  const shipping = Number(order.shippingFee || order.receipt?.shippingFee || 0);
  const discount = Number(order.discountAmount || order.receipt?.discountAmount || 0);
  const amountLabel = isPaid ? "Payment amount" : "Amount due";
  const paymentDetails = [
    ["Payment method / channel", paymentMethod],
    ["Merchant", "Cold Air Conditioning Trading"],
    [amountLabel, money(order.totalAmount)],
    ["Payment status", paymentStatus],
    ["Payment reference", paymentReference],
    ["Order reference", order.orderCode],
    ["Transaction date", isPaid ? paidDate : ""],
    ["Remarks", isPaid ? "Payment confirmed for this order." : isCashOnDelivery ? "Pay the amount due when the order is delivered." : "Payment has not been confirmed yet."],
  ].filter(([, value]) => value);
  const details = [
    ["Recipient", recipient], ["Delivery address", delivery],
  ].filter(([, value]) => value);
  const detailsHtml = details.map(([label, value]) => `<p style="margin:6px 0;line-height:1.5"><strong>${label}:</strong> ${escape(value)}</p>`).join("");
  const detailsText = details.map(([label, value]) => `${label}: ${value}`).join("\n");
  const rows = items.map((item) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0">${escape(item.name)} <span style="color:#475569">× ${escape(item.quantity || 1)}</span></td><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right">${escape(money(Number(item.price || 0) * Number(item.quantity || 1)))}</td></tr>`).join("");
  const breakdown = [
    ["Subtotal", subtotal], ["Discount", discount], ["VAT", vat], ["Delivery", shipping],
  ].filter(([label, value]) => label === "Subtotal" ? value > 0 : value > 0);
  const breakdownHtml = breakdown.map(([label, value]) => `<tr><td style="padding:5px 0;color:#475569">${label}</td><td style="padding:5px 0;text-align:right">${escape(money(value))}</td></tr>`).join("");
  const breakdownText = breakdown.map(([label, value]) => `${label}: ${money(value)}`).join("\n");
  const paymentHtml = paymentDetails.map(([label, value]) => `<tr><td style="padding:7px 10px;border-bottom:1px solid #dbe5ed;color:#475569;vertical-align:top">${escape(label)}</td><td style="padding:7px 10px;border-bottom:1px solid #dbe5ed;text-align:right;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join("");
  const paymentText = paymentDetails.map(([label, value]) => `${label}: ${value}`).join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f8fb;color:#10233b;font-family:Arial,sans-serif"><div style="max-width:620px;margin:24px auto;background:#ffffff;border:1px solid #dbe5ed;border-radius:12px;overflow:hidden"><div style="background:#075985;color:#ffffff;padding:24px 28px"><p style="margin:0 0 6px;font-size:13px;letter-spacing:1px">COLD AIR ACT</p><h1 style="font-size:24px;line-height:1.3;margin:0">${escape(title)}</h1></div><div style="padding:28px"><p style="line-height:1.6">${escape(introduction)}</p><p><strong>Order:</strong> ${escape(order.orderCode)}</p>${detailsHtml}<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr><th style="text-align:left;padding-bottom:8px">Item</th><th style="text-align:right;padding-bottom:8px">Amount</th></tr></thead><tbody>${rows}</tbody></table><table style="border-collapse:collapse;width:100%;max-width:300px;margin:12px 0 12px auto;font-size:14px">${breakdownHtml}<tr><td style="padding:8px 0;border-top:1px solid #cbd5e1;font-weight:bold">Total</td><td style="padding:8px 0;border-top:1px solid #cbd5e1;text-align:right;font-weight:bold">${escape(money(order.totalAmount))}</td></tr></table><h2 style="font-size:17px;margin:22px 0 8px">${isPaid ? "Payment confirmation" : "Payment details"}</h2><table style="border-collapse:collapse;width:100%;font-size:14px">${paymentHtml}</table><p style="margin-top:16px;padding:14px;background:#eff6ff;border-radius:8px;line-height:1.5">${escape(paymentLine)}</p><p style="line-height:1.6">Track updates in My Orders on the Cold Air ACT website.</p><p><a href="https://www.coldair-act.online/my-orders" style="display:inline-block;padding:12px 20px;background:#075985;color:#ffffff;text-decoration:none;border-radius:7px">View My Orders</a></p></div><div style="padding:16px 28px;background:#f8fafc;color:#475569;font-size:12px">Cold Air Conditioning Trading · Please contact support if you do not recognize this order.</div></div></body></html>`;
  return { html, text: `${title}\n${introduction}\nOrder: ${order.orderCode}\n${detailsText}\n${items.map((item) => `${item.name} × ${item.quantity || 1}`).join("\n")}\n${breakdownText}\nTotal: ${money(order.totalAmount)}\n\n${isPaid ? "Payment confirmation" : "Payment details"}\n${paymentText}\n\n${paymentLine}\nTrack updates: https://www.coldair-act.online/my-orders` };
};

module.exports = { orderEmail };
