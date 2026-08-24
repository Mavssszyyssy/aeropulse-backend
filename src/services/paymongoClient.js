const env = require("../config/env");

class PaymongoError extends Error {
  constructor(message, { status = 500, details = null } = {}) {
    super(message);
    this.name = "PaymongoError";
    this.status = status;
    this.details = details;
  }
}

const selectedKeyMode = () => {
  const key = String(env.paymongoSecretKey || "");
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return "unknown";
};

const configurationError = () => {
  if (!env.paymongoSecretKey) return "PayMongo secret key is not configured.";
  const selectedMode = String(env.paymongoMode || "").toLowerCase();
  const keyMode = selectedKeyMode();
  if (selectedMode && ["test", "live"].includes(selectedMode) && keyMode !== selectedMode) {
    return `PAYMONGO_MODE is ${selectedMode}, but the configured PayMongo secret key is ${keyMode}. Use the matching ${selectedMode} secret key.`;
  }
  return "";
};

const isConfigured = () => !configurationError();

const authHeader = () =>
  `Basic ${Buffer.from(`${env.paymongoSecretKey}:`).toString("base64")}`;

const toCentavos = (amount) => Math.max(0, Math.round(Number(amount || 0) * 100));

const normalizePaymentMethods = (paymentMethod) => {
  const method = String(paymentMethod || "").toLowerCase();
  if (method === "gcash") return ["gcash"];
  if (method === "maya" || method === "paymaya") return ["paymaya"];
  if (method === "credit" || method === "card") return ["card"];
  if (method === "online") return ["card", "gcash", "paymaya"];
  return ["card", "gcash", "paymaya"];
};

const requestPaymongo = async (path, { method = "GET", body } = {}) => {
  const configurationIssue = configurationError();
  if (configurationIssue) {
    throw new PaymongoError(configurationIssue, { status: 500 });
  }

  const response = await fetch(`${env.paymongoApiBaseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    const rawMessage =
      payload?.errors?.[0]?.detail ||
      payload?.errors?.[0]?.code ||
      payload?.message ||
      "PayMongo request failed.";
    const errorCode = payload?.errors?.[0]?.code || "";
    const message =
      response.status === 401 &&
      errorCode === "network_error" &&
      String(rawMessage || "").includes("404")
        ? "PayMongo rejected the API key. Please copy the exact Secret Key from the PayMongo dashboard; screenshots can easily misread characters."
        : rawMessage;
    throw new PaymongoError(message, {
      status: response.status,
      details: payload,
    });
  }

  return payload;
};

const getCheckoutUrl = (session) => {
  const attributes = session?.data?.attributes || {};
  return (
    attributes.checkout_url ||
    attributes.url ||
    attributes.redirect?.checkout_url ||
    attributes.redirect?.url ||
    ""
  );
};

const sumLineItems = (items = []) =>
  items.reduce(
    (sum, item) => sum + Number(item.amount || 0) * Number(item.quantity || 1),
    0,
  );

const createCheckoutSession = async ({ order, successUrl, cancelUrl }) => {
  let lineItems = (order.items || []).map((item) => ({
    currency: "PHP",
    amount: toCentavos(item.price),
    name: String(item.name || "AeroPulse order item").slice(0, 120),
    quantity: Number(item.quantity || 1),
    description: String(item.specs || item.sourceBranch || "").slice(0, 255),
  }));
  const totalCentavos = toCentavos(order.totalAmount);
  const vatCentavos = toCentavos(order.vatAmount);
  const shippingCentavos = toCentavos(order.shippingFee || order.deliveryFee);
  const discountCentavos = toCentavos(order.discountAmount);

  if (vatCentavos > 0) {
    lineItems.push({
      currency: "PHP",
      amount: vatCentavos,
      name: "Value-added tax (12%)",
      quantity: 1,
    });
  }

  if (shippingCentavos > 0) {
    lineItems.push({
      currency: "PHP",
      amount: shippingCentavos,
      name: "Delivery fee",
      quantity: 1,
    });
  }

  const currentTotalCentavos = sumLineItems(lineItems);
  const differenceCentavos = totalCentavos - currentTotalCentavos;

  if (discountCentavos > 0 || differenceCentavos < 0) {
    lineItems = [
      {
        currency: "PHP",
        amount: totalCentavos,
        name: `Order ${order.orderCode}`,
        quantity: 1,
        description: "Final order total including taxes, delivery fees, and discounts.",
      },
    ];
  } else if (differenceCentavos > 0) {
    lineItems.push({
      currency: "PHP",
      amount: differenceCentavos,
      name: "Taxes and delivery fees",
      quantity: 1,
    });
  }

  const payload = {
    data: {
      attributes: {
        line_items: lineItems.length
          ? lineItems
          : [
              {
                currency: "PHP",
                amount: toCentavos(order.totalAmount),
                name: `Order ${order.orderCode}`,
                quantity: 1,
              },
            ],
        payment_method_types: normalizePaymentMethods(order.paymentMethod),
        success_url: successUrl,
        cancel_url: cancelUrl,
        description: `AeroPulse order ${order.orderCode}`,
        reference_number: order.orderCode,
        metadata: {
          order_id: String(order._id || order.id || ""),
          order_code: order.orderCode,
          customer_id: String(order.customer || ""),
        },
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
      },
    },
  };

  const session = await requestPaymongo("/v1/checkout_sessions", {
    method: "POST",
    body: payload,
  });

  const checkoutUrl = getCheckoutUrl(session);
  if (!checkoutUrl) {
    throw new PaymongoError("PayMongo did not return a checkout URL.", {
      status: 502,
      details: session,
    });
  }

  return {
    raw: session,
    id: session?.data?.id || "",
    checkoutUrl,
    status: session?.data?.attributes?.status || "active",
  };
};

const getCheckoutSession = async (checkoutSessionId) => {
  const sessionId = String(checkoutSessionId || "").trim();
  if (!sessionId) {
    throw new PaymongoError("PayMongo checkout session ID is required.", { status: 400 });
  }
  return requestPaymongo(`/v1/checkout_sessions/${encodeURIComponent(sessionId)}`);
};

module.exports = {
  PaymongoError,
  createCheckoutSession,
  getCheckoutSession,
  isConfigured,
  getConfigurationError: configurationError,
  normalizePaymentMethods,
};
