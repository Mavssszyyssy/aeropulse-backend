const Order = require("../models/Order");
const Product = require("../models/Product");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Unit = require("../models/Unit");
const mongoose = require("mongoose");
const env = require("../config/env");
const { ensureSampleInventory } = require("./productController");
const { canSendEmail, sendEmail } = require("../utils/email");
const {
  getBranchSearchOrder,
  resolvePreferredBranch,
} = require("../domain/branchRouting");
const {
  PaymongoError,
  createCheckoutSession,
  getCheckoutSession,
  isConfigured: isPaymongoConfigured,
} = require("../services/paymongoClient");

const workflowLabel = (status) => {
  switch (status) {
    case "to_pay":
      return "TO PAY";
    case "to_deliver":
      return "TO DELIVER";
    case "to_install":
      return "TO INSTALL";
    case "complete":
      return "COMPLETE";
    default:
      return "CANCELLED";
  }
};

// Monetary amounts are calculated only on the server from the resolved
// catalogue items and destination branch. Web and mobile may display an
// estimate, but neither client is allowed to decide the stored transaction
// amount.
const DELIVERY_FEE_BY_BRANCH = {
  Bulacan: 380,
  Cavite: 350,
  Laguna: 400,
  Bataan: 420,
  Pangasinan: 550,
  Ilocos: 600,
};
const DEFAULT_DELIVERY_FEE = 400;
const VAT_RATE = 0.12;
const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;
const calculateOrderTotals = (items = [], branch = "") => {
  const subtotal = roundMoney(
    items.reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
      0,
    ),
  );
  const discountAmount = 0;
  const vatAmount = roundMoney((subtotal - discountAmount) * VAT_RATE);
  const shippingFee = Number(DELIVERY_FEE_BY_BRANCH[branch] || DEFAULT_DELIVERY_FEE);
  return {
    subtotal,
    vatAmount,
    shippingFee,
    discountAmount,
    total: roundMoney(subtotal - discountAmount + vatAmount + shippingFee),
  };
};

const normalizePhMobile = (value = "") => {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  return digits;
};

const normalizePostalCode = (value = "") => {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{4}$/.test(digits) ? digits : "";
};

const normalizeAddress = (address = {}) => {
  const rawStreet = String(
    address.street ||
      [
        address.apartmentUnit || address.apartment_unit,
        address.propertyBlockLot || address.property_block_lot,
        address.thoroughfare,
      ]
        .filter(Boolean)
        .join(", ") ||
      address.address ||
      "",
  ).trim();
  const rawAddress = String(address.address || "").trim();
  const city = String(address.city || address.municipality || "").trim();

  return {
    _id: String(address._id || address.id || "").trim(),
    label: String(address.label || "").trim(),
    type: String(address.type || "other").trim(),
    name: String(address.name || "").trim(),
    phone: normalizePhMobile(address.phone),
    street: rawStreet || rawAddress,
    barangay: String(address.barangay || address.submunicipality || "").trim(),
    city,
    province: String(address.province || "").trim(),
    region: String(address.region || "").trim(),
    postalCode: normalizePostalCode(address.postalCode || address.postal_code),
    isDefault: Boolean(address.isDefault),
  };
};

const mergeAddress = (primary = {}, fallback = {}) =>
  normalizeAddress({
    ...fallback,
    ...primary,
    name: primary.name || fallback.name,
    phone: primary.phone || fallback.phone,
    street: primary.street || fallback.street || fallback.address,
    barangay: primary.barangay || fallback.barangay || fallback.submunicipality,
    city: primary.city || fallback.city || fallback.municipality,
    province: primary.province || fallback.province,
    region: primary.region || fallback.region,
    postalCode: primary.postalCode || primary.postal_code || fallback.postalCode || fallback.postal_code,
  });

const isValidAddress = (address = {}) => {
  if (!address.name || !address.phone || !address.street) return false;
  if (!/^09\d{9}$/.test(normalizePhMobile(address.phone))) return false;
  return true;
};

const getAddressValidationMessage = (address = {}) => {
  if (!address.name) return "recipient name is missing";
  if (!address.phone) return "phone number is missing";
  if (!/^09\d{9}$/.test(normalizePhMobile(address.phone))) {
    return "phone number must be a valid Philippine mobile number";
  }
  if (!address.street) return "street or full address is missing";
  return "";
};

const ensureOrderAddress = (address = {}, user = {}) => {
  const normalized = normalizeAddress(address);
  const customerName =
    user.name || `${user.name_first || ""} ${user.name_last || ""}`.trim();
  return {
    ...normalized,
    name: normalized.name || customerName || user.email || "Customer",
    phone: normalizePhMobile(normalized.phone || user.phone || ""),
    street:
      normalized.street ||
      normalized.barangay ||
      normalized.city ||
      String(user.address || "").trim() ||
      "Mobile checkout address pending",
    barangay: normalized.barangay || "",
    city: normalized.city || "",
    province: normalized.province || "",
    region: normalized.region || "",
    postalCode: normalized.postalCode || "",
  };
};

const withOptionalSession = (query, session = null) =>
  session ? query.session(session) : query;

const resolveProductForOrderItem = async (item, session = null) => {
  const candidateIds = [
    item.productId,
    item.product_id,
    item._id,
    item.id,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const productId of candidateIds) {
    if (!mongoose.Types.ObjectId.isValid(productId)) continue;
    const byId = await withOptionalSession(Product.findById(productId), session);
    if (byId) return byId;
  }

  const candidateSkus = [item.sku, item.model]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const sku of candidateSkus) {
    const bySku = await withOptionalSession(
      Product.findOne({ sku: new RegExp(`^${sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }),
      session,
    );
    if (bySku) return bySku;
  }

  const name = String(item.name || "").trim();
  const specs = String(item.specs || "").trim();
  if (name && specs) {
    const byNameAndSpecs = await withOptionalSession(
      Product.findOne({
        name: new RegExp(`^${name.replace(/\s*AC\s*$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(AC)?$`, "i"),
        specs: new RegExp(`^${specs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      }),
      session,
    );
    if (byNameAndSpecs) return byNameAndSpecs;
  }

  return null;
};

const randomSerialToken = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const buildSerialNumber = (product) => {
  const skuPart = String(product?.sku || "AC")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toUpperCase();
  const timePart = Date.now().toString(36).toUpperCase();
  return `CAACT-${skuPart || "AC"}-${timePart}-${randomSerialToken()}`;
};

const buildSerialQrCode = (product, serialNumber) =>
  [
    `AC_UNIT:${serialNumber}`,
    `PRODUCT:${product?._id || product?.id || ""}`,
    `SKU:${product?.sku || ""}`,
  ].join("|");

const generateUniqueSerialNumber = async (product, seen, session = null) => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const serialNumber = buildSerialNumber(product);
    if (seen.has(serialNumber)) continue;
    const exists = await withOptionalSession(
      Product.exists({
        "serialUnits.serialNumber": serialNumber,
      }),
      session,
    );
    if (!exists) {
      seen.add(serialNumber);
      return serialNumber;
    }
  }
  throw new Error("Unable to generate a unique serial number");
};

const ensureAvailableSerialUnits = async (
  product,
  branch,
  quantityNeeded,
  session = null,
) => {
  if (!Array.isArray(product.serialUnits)) {
    product.serialUnits = [];
  }

  const matchesBranch = (unit) => !branch || !unit.branch || unit.branch === branch;
  const available = product.serialUnits.filter(
    (unit) => unit.status === "available" && matchesBranch(unit),
  );
  const missing = Math.max(0, Number(quantityNeeded || 0) - available.length);
  if (missing <= 0) return false;

  const seen = new Set(
    product.serialUnits
      .map((unit) => String(unit.serialNumber || "").trim())
      .filter(Boolean),
  );

  for (let index = 0; index < missing; index += 1) {
    const serialNumber = await generateUniqueSerialNumber(product, seen, session);
    product.serialUnits.push({
      serialNumber,
      qrCode: buildSerialQrCode(product, serialNumber),
      branch,
      status: "available",
    });
  }

  return true;
};

const reserveSerialUnitsForOrder = async (
  product,
  branch,
  quantityNeeded,
  orderCode,
  session = null,
) => {
  const addedUnits = await ensureAvailableSerialUnits(
    product,
    branch,
    quantityNeeded,
    session,
  );
  if (addedUnits) {
    await (session ? product.save({ session }) : product.save());
  }

  const reservedAt = new Date();
  const reserved = [];
  const matchesBranch = (unit) => !branch || !unit.branch || unit.branch === branch;
  const candidateSerials = (product.serialUnits || [])
    .filter((unit) => unit.status === "available" && matchesBranch(unit))
    .map((unit) => ({
      serialNumber: String(unit.serialNumber || "").trim(),
      qrCode: String(unit.qrCode || "").trim() || buildSerialQrCode(product, unit.serialNumber),
    }))
    .filter((unit) => unit.serialNumber);

  for (const candidate of candidateSerials) {
    if (reserved.length >= quantityNeeded) break;

    const updateResult = await withOptionalSession(
      Product.updateOne(
        {
          _id: product._id,
          serialUnits: {
            $elemMatch: {
              serialNumber: candidate.serialNumber,
              status: "available",
            },
          },
        },
        {
          $set: {
            "serialUnits.$.status": "assigned",
            "serialUnits.$.assignedOrderCode": orderCode,
            "serialUnits.$.assignedAt": reservedAt,
            "serialUnits.$.registeredAt": null,
            "serialUnits.$.qrCode": candidate.qrCode,
          },
        },
      ),
      session,
    );
    if (!updateResult.modifiedCount) continue;

    reserved.push({
      serialNumber: candidate.serialNumber,
      qrCode: candidate.qrCode,
    });
  }

  if (reserved.length < quantityNeeded) {
    throw new HttpError(
      409,
      `Insufficient serial-numbered stock for ${product.name}.`,
    );
  }

  return reserved;
};

const releaseReservedSerialUnits = async (productId, serialNumbers = [], session = null) => {
  const cleanSerials = serialNumbers
    .map((serial) => String(serial || "").trim())
    .filter(Boolean);
  if (cleanSerials.length === 0) return;

  await withOptionalSession(
    Product.updateOne(
      { _id: productId },
      {
        $set: {
          "serialUnits.$[unit].status": "available",
          "serialUnits.$[unit].assignedOrderId": "",
          "serialUnits.$[unit].assignedOrderCode": "",
          "serialUnits.$[unit].assignedAt": null,
          "serialUnits.$[unit].registeredAt": null,
        },
      },
      {
        arrayFilters: [{ "unit.serialNumber": { $in: cleanSerials } }],
      },
    ),
    session,
  );
};

const decrementProductStockForOrder = async (
  product,
  branch,
  quantityNeeded,
  hasBranchSnapshot,
  session = null,
) => {
  const productId = product?._id;
  if (!productId || !branch || quantityNeeded < 1) {
    throw new HttpError(409, "Unable to reserve product stock.");
  }

  const branchStockPath = `branchStock.${branch}`;
  const query = hasBranchSnapshot
    ? {
        _id: productId,
        [branchStockPath]: { $gte: quantityNeeded },
      }
    : {
        _id: productId,
        stock: { $gte: quantityNeeded },
      };
  const inc = hasBranchSnapshot
    ? {
        stock: -quantityNeeded,
        [branchStockPath]: -quantityNeeded,
      }
    : {
        stock: -quantityNeeded,
      };

  const updateResult = await withOptionalSession(
    Product.updateOne(query, { $inc: inc }),
    session,
  );
  if (!updateResult.modifiedCount) {
    throw new HttpError(
      409,
      `Stock changed while reserving ${product.name}. Please try again.`,
    );
  }

  const updatedProduct = await withOptionalSession(
    Product.findById(productId).select("name stock branchStock threshold"),
    session,
  );
  const remainingBranchStock = hasBranchSnapshot
    ? Number(updatedProduct?.branchStock?.get(branch) || 0)
    : Number(updatedProduct?.stock || 0);
  if (remainingBranchStock !== 0) return;

  try {
    const recipients = await User.find({
      role: { $in: ["admin", "superadmin"] },
      accountStatus: { $ne: "disabled" },
      $or: [
        { role: "superadmin" },
        { assignedBranch: branch },
        { activeBranch: branch },
        { assignedBranch: "" },
        { activeBranch: "" },
      ],
    }).select("_id");
    const title = "Out of stock";
    const message = `${product.name} is now out of stock${branch ? ` at ${branch}` : ""}. SuperAdmin action is required.`;
    if (recipients.length) {
      await Notification.insertMany(
        recipients.map((recipient) => ({
          user: recipient._id,
          type: "inventory",
          title,
          message,
          unread: true,
          status: "unread",
        })),
      );
    }
  } catch (error) {
    console.error("Failed to create zero-stock notifications:", error);
  }
};

const restoreReservedProductStock = async (
  productId,
  branch,
  quantity,
  hasBranchSnapshot,
  session = null,
) => {
  if (!productId || !branch || Number(quantity) < 1) return;
  const increment = hasBranchSnapshot
    ? { stock: Number(quantity), [`branchStock.${branch}`]: Number(quantity) }
    : { stock: Number(quantity) };
  await withOptionalSession(Product.updateOne({ _id: productId }, { $inc: increment }), session);
};

const lifecycleActions = {
  approve: {
    from: ["to_pay"],
    to: "to_deliver",
    status: "paid",
    deliveryStatus: "preparing",
    title: "Order approved",
    message: (orderCode) =>
      `Your order ${orderCode} was approved. Your order is now in TO DELIVER stage.`,
  },
  dispatch: {
    from: ["to_deliver"],
    to: "to_install",
    status: "paid",
    deliveryStatus: "dispatched",
    title: "Order dispatched",
    message: (orderCode) =>
      `Your order ${orderCode} is on the way and moved to TO INSTALL stage.`,
  },
  complete: {
    from: ["to_install"],
    to: "complete",
    status: "paid",
    deliveryStatus: "completed",
    title: "Order completed",
    message: (orderCode) =>
      `Your order ${orderCode} has been completed. Thank you for choosing AeroPulse.`,
  },
  cancel: {
    from: ["to_pay", "to_deliver"],
    to: "cancelled",
    status: "cancelled",
    deliveryStatus: "cancelled",
    title: "Order cancelled",
    message: (orderCode) =>
      `Your order ${orderCode} has been cancelled. Please contact support if you need assistance.`,
  },
};

const restoreStockForCancelledOrder = async (order, session = null) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  await Promise.all(
    items.map(async (item) => {
      const quantity = Number(item.quantity || 0);
      const branch = String(item.sourceBranch || order.stockSourceBranch || "").trim();
      if (quantity < 1 || !branch) return;

      const productId = String(item.productId || "").trim();
      const serialNumbers = collectItemSerialNumbers(item);
      const query = mongoose.Types.ObjectId.isValid(productId)
        ? { _id: productId }
        : serialNumbers.length > 0
          ? { "serialUnits.serialNumber": { $in: serialNumbers } }
          : null;
      if (!query) return;

      await withOptionalSession(
        Product.updateOne(query, {
          $inc: {
            stock: quantity,
            [`branchStock.${branch}`]: quantity,
          },
        }),
        session,
      );
    }),
  );
};

const releaseOrderInventoryOnce = async (order, reason = "") => {
  if (
    !order ||
    order.stockReservationStatus === "released" ||
    order.stockReservationStatus === "consumed" ||
    order.stockReleasedAt ||
    order.workflowStatus === "complete"
  ) {
    return false;
  }

  await restoreStockForCancelledOrder(order);
  await updateSerialUnitsForOrder(order, "cancelled");
  order.stockReservationStatus = "released";
  order.stockReleasedAt = new Date();
  if (reason && !order.cancellationReason) order.cancellationReason = reason;
  return true;
};

const reReserveReleasedOrderInventory = async (order) => {
  if (!order || order.stockReservationStatus !== "released") return;

  const completedReservations = [];
  try {
    for (const item of order.items || []) {
      const quantity = Number(item.quantity || 0);
      const productId = String(item.productId || "").trim();
      const branch = String(item.sourceBranch || order.stockSourceBranch || "").trim();
      if (quantity < 1 || !mongoose.Types.ObjectId.isValid(productId) || !branch) {
        throw new HttpError(409, "This order no longer has a valid inventory reservation.");
      }

      const product = await Product.findById(productId);
      if (!product) throw new HttpError(409, `Product ${item.name || productId} is no longer available.`);
      const hasBranchSnapshot = Array.from(product.branchStock?.values?.() || []).some(
        (value) => Number(value || 0) > 0,
      );
      const reservedUnits = await reserveSerialUnitsForOrder(
        product,
        branch,
        quantity,
        order.orderCode,
      );
      const serialNumbers = reservedUnits.map((unit) => unit.serialNumber);
      try {
        await decrementProductStockForOrder(
          product,
          branch,
          quantity,
          hasBranchSnapshot,
        );
      } catch (error) {
        await releaseReservedSerialUnits(product._id, serialNumbers);
        throw error;
      }

      completedReservations.push({ productId, branch, quantity, hasBranchSnapshot, serialNumbers });
      item.serialNumbers = serialNumbers;
      item.serialUnits = reservedUnits;
    }

    order.stockReservationStatus = "reserved";
    order.stockReleasedAt = null;
    await order.save();
  } catch (error) {
    await Promise.allSettled(
      completedReservations.reverse().map(async (reservation) => {
        await restoreReservedProductStock(
          reservation.productId,
          reservation.branch,
          reservation.quantity,
          reservation.hasBranchSnapshot,
        );
        await releaseReservedSerialUnits(
          reservation.productId,
          reservation.serialNumbers,
        );
      }),
    );
    throw error;
  }
};

const rollbackUnpaidOnlineOrder = async (order) => {
  if (!order || !isOnlinePaymentMethod(order.paymentMethod)) return;

  try {
    await releaseOrderInventoryOnce(order, "PayMongo checkout could not be started.");
    order.workflowStatus = "cancelled";
    order.status = "cancelled";
    order.paymentStatus = "failed";
    await order.save();
  } catch (rollbackError) {
    console.error("Unable to roll back unpaid online order:", rollbackError);
  }
};

const updateSerialUnitsForOrder = async (order, nextStatus) => {
  const serialNumbers = (order.items || []).flatMap((item) =>
    collectItemSerialNumbers(item),
  );
  if (serialNumbers.length === 0) return;

  const products = await Product.find({
    "serialUnits.serialNumber": { $in: serialNumbers },
  });
  const now = new Date();

  await Promise.all(
    products.map(async (product) => {
      let changed = false;
      for (const unit of product.serialUnits || []) {
        if (!serialNumbers.includes(unit.serialNumber)) continue;

        if (nextStatus === "complete") {
          unit.status = "sold";
          unit.registeredAt = unit.registeredAt || now;
        } else if (nextStatus === "cancelled") {
          unit.status = "available";
          unit.assignedOrderId = "";
          unit.assignedOrderCode = "";
          unit.assignedAt = null;
          unit.registeredAt = null;
        } else {
          unit.status = "assigned";
          unit.assignedOrderId = String(order._id || order.id || "");
          unit.assignedOrderCode = order.orderCode;
          unit.assignedAt = unit.assignedAt || now;
        }
        changed = true;
      }

      if (changed) {
        await product.save();
      }
    }),
  );
};

const collectItemSerialNumbers = (item = {}) => {
  const fromNumbers = Array.isArray(item.serialNumbers)
    ? item.serialNumbers
    : [];
  const fromUnits = Array.isArray(item.serialUnits)
    ? item.serialUnits.map((unit) => unit?.serialNumber)
    : [];

  return Array.from(
    new Set(
      [...fromNumbers, ...fromUnits]
        .map((serial) => String(serial || "").trim())
        .filter(Boolean),
    ),
  );
};

const orderToResponse = (order) => ({
  ...order.toJSON(),
  workflowLabel: workflowLabel(order.workflowStatus),
});

const isOnlinePaymentMethod = (paymentMethod = "") =>
  ["gcash", "credit", "card", "maya", "paymaya", "online"].includes(
    String(paymentMethod || "").toLowerCase(),
  );

const getPaymongoRuntimeStatus = () => {
  const configuredMode = String(env.paymongoMode || process.env.PAYMONGO_MODE || "").trim().toLowerCase();
  const keyPrefix = String(env.paymongoSecretKey || "").startsWith("sk_live_")
    ? "live"
    : String(env.paymongoSecretKey || "").startsWith("sk_test_")
      ? "test"
      : "";
  return {
    provider: "paymongo",
    configured: isPaymongoConfigured(),
    mode: configuredMode || keyPrefix || "unknown",
    keyType: keyPrefix || "unknown",
    returnBaseUrl: String(
      process.env.PAYMONGO_RETURN_BASE_URL ||
        process.env.BACKEND_PUBLIC_URL ||
        env.backendPublicUrl ||
        "",
    ),
  };
};

const normalizePaymentReturnTarget = (value = "") => {
  const target = String(value || "").trim().toLowerCase();
  return ["mobile", "app", "native"].includes(target) ? "mobile" : "web";
};

const mobileDeepLinkForOrder = (orderId, paymentState) => {
  const scheme = String(process.env.MOBILE_URL_SCHEME || "coldair")
    .replace(/:\/?\/?$/, "")
    .trim() || "coldair";
  return `${scheme}://customer/order-confirmation/${encodeURIComponent(orderId)}?payment=${encodeURIComponent(paymentState)}`;
};

const buildRequestBaseUrl = (req) => {
  const configured =
    process.env.PAYMONGO_RETURN_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    "";
  if (configured) return String(configured).replace(/\/+$/, "");

  const host = req?.get?.("x-forwarded-host") || req?.get?.("host") || "";
  if (!host) return envFrontendUrl();
  const proto = req?.get?.("x-forwarded-proto") || req?.protocol || "http";
  return `${proto}://${host}`.replace(/\/+$/, "");
};

const buildPaymentReturnUrls = (order, options = {}) => {
  const orderId = String(order._id || order.id || "");
  const target = normalizePaymentReturnTarget(options.returnTarget);
  if (target === "mobile") {
    const returnBaseUrl = buildRequestBaseUrl(options.req);
    const returnPath = `/api/orders/${encodeURIComponent(orderId)}/paymongo/return`;
    return {
      successUrl: `${returnBaseUrl}${returnPath}?payment=success&target=mobile`,
      cancelUrl: `${returnBaseUrl}${returnPath}?payment=cancelled&target=mobile`,
    };
  }

  return {
    successUrl: `${envFrontendUrl()}/order-confirmation/${encodeURIComponent(orderId)}?payment=success`,
    cancelUrl: `${envFrontendUrl()}/order-confirmation/${encodeURIComponent(orderId)}?payment=cancelled`,
  };
};

const envFrontendUrl = () =>
  String(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");

const attachPaymongoCheckout = async (order, options = {}) => {
  if (!isOnlinePaymentMethod(order.paymentMethod)) return null;
  if (!isPaymongoConfigured()) {
    throw new HttpError(500, "PayMongo secret key is not configured on the backend.");
  }

  const { successUrl, cancelUrl } = buildPaymentReturnUrls(order, options);
  const checkout = await createCheckoutSession({
    order,
    successUrl,
    cancelUrl,
  });

  order.paymentProvider = "paymongo";
  order.paymentStatus = "pending";
  order.paymongo = {
    ...(order.paymongo?.toObject?.() || order.paymongo || {}),
    checkoutSessionId: checkout.id,
    checkoutUrl: checkout.checkoutUrl,
    referenceNumber: order.orderCode,
    returnTarget: normalizePaymentReturnTarget(options.returnTarget),
    successUrl,
    cancelUrl,
    status: checkout.status,
    raw: checkout.raw,
  };
  await order.save();

  return checkout;
};

const collectPaymongoIdentifiers = (value, result = {}) => {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPaymongoIdentifiers(item, result));
    return result;
  }

  Object.entries(value).forEach(([key, raw]) => {
    const normalizedKey = String(key || "").toLowerCase();
    if (raw && typeof raw === "object") {
      collectPaymongoIdentifiers(raw, result);
      return;
    }

    const text = String(raw || "").trim();
    if (!text) return;
    if (normalizedKey === "order_id") result.orderId = result.orderId || text;
    if (normalizedKey === "order_code") result.orderCode = result.orderCode || text;
    if (normalizedKey === "reference_number" || normalizedKey === "reference") {
      result.orderCode = result.orderCode || text;
    }
    if (normalizedKey === "checkout_session_id" || normalizedKey === "checkout_session") {
      result.checkoutSessionId = result.checkoutSessionId || text;
    }
    if (normalizedKey === "payment_intent_id" || normalizedKey === "payment_intent") {
      result.paymentIntentId = result.paymentIntentId || text;
    }
    if (normalizedKey === "payment_id" || normalizedKey === "payment") {
      result.paymentId = result.paymentId || text;
    }
  });

  return result;
};

const extractPaymongoEvent = (payload = {}) => {
  const eventType = String(payload?.data?.attributes?.type || payload?.type || "").trim();
  const resource = payload?.data?.attributes?.data || payload?.data || {};
  const resourceId = String(resource?.id || "").trim();
  const resourceType = String(resource?.type || "").trim();
  const attributes = resource?.attributes || {};
  const metadata = attributes.metadata || {};
  const paymentIntent =
    attributes.payment_intent ||
    attributes.payment_intent_id ||
    attributes.payment_intent_id ||
    "";
  const checkoutSession =
    attributes.checkout_session ||
    attributes.checkout_session_id ||
    metadata.checkout_session_id ||
    "";
  const identifiers = collectPaymongoIdentifiers(payload);

  return {
    eventType,
    resourceId,
    resourceType,
    attributes,
    metadata,
    paymentId: resourceType === "payment" ? resourceId : String(attributes.payment_id || identifiers.paymentId || ""),
    paymentIntentId:
      typeof paymentIntent === "string"
        ? paymentIntent || identifiers.paymentIntentId || ""
        : String(paymentIntent?.id || identifiers.paymentIntentId || ""),
    checkoutSessionId:
      typeof checkoutSession === "string"
        ? checkoutSession || identifiers.checkoutSessionId || ""
        : String(checkoutSession?.id || identifiers.checkoutSessionId || ""),
    orderId: String(metadata.order_id || attributes.order_id || identifiers.orderId || "").trim(),
    orderCode: String(
      metadata.order_code ||
        attributes.reference_number ||
        attributes.reference ||
        identifiers.orderCode ||
        "",
    ).trim(),
  };
};

const findOrderForPaymongoEvent = async (event) => {
  const conditions = [];
  if (mongoose.Types.ObjectId.isValid(event.orderId)) conditions.push({ _id: event.orderId });
  if (event.orderCode) conditions.push({ orderCode: event.orderCode });
  if (event.paymentId) conditions.push({ "paymongo.paymentId": event.paymentId });
  if (event.paymentIntentId) conditions.push({ "paymongo.paymentIntentId": event.paymentIntentId });
  if (event.checkoutSessionId) conditions.push({ "paymongo.checkoutSessionId": event.checkoutSessionId });
  if (conditions.length === 0) return null;
  return Order.findOne({ $or: conditions });
};

const applyPaymongoEventToOrder = async (order, event, rawPayload = {}) => {
  if (!order) return null;
  const eventType = String(event.eventType || "").toLowerCase();
  const eventKey = [
    eventType,
    event.resourceId || event.paymentId || event.paymentIntentId || event.checkoutSessionId || "",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(":");
  const previousPaymongo = order.paymongo?.toObject?.() || order.paymongo || {};
  if (eventKey && previousPaymongo.lastEventKey === eventKey) {
    return order;
  }
  const isPaid =
    eventType === "payment.paid" ||
    eventType === "checkout_session.payment.paid" ||
    eventType === "checkout_session.completed" ||
    String(event.attributes?.status || "").toLowerCase() === "paid" ||
    String(event.attributes?.status || "").toLowerCase() === "succeeded";
  const isFailed =
    eventType === "payment.failed" ||
    eventType === "checkout_session.expired" ||
    ["failed", "expired", "cancelled", "canceled"].includes(
      String(event.attributes?.status || "").toLowerCase(),
    );

  order.paymentProvider = "paymongo";
  order.paymongo = {
    ...previousPaymongo,
    checkoutSessionId: event.checkoutSessionId || order.paymongo?.checkoutSessionId || "",
    paymentIntentId: event.paymentIntentId || order.paymongo?.paymentIntentId || "",
    paymentId: event.paymentId || order.paymongo?.paymentId || "",
    referenceNumber: event.orderCode || order.paymongo?.referenceNumber || order.orderCode,
    status: event.attributes?.status || order.paymongo?.status || "",
    lastEventType: event.eventType,
    lastEventKey: eventKey,
    raw: rawPayload,
  };

  if (isPaid) {
    // A late payment callback can arrive after an earlier failed/expired
    // callback released the reservation. Re-reserve before approving so the
    // paid order cannot advance with missing stock or serial assignments.
    await reReserveReleasedOrderInventory(order);
    order.paymentStatus = "paid";
    order.status = "paid";
    order.paymongo.paidAt = order.paymongo.paidAt || new Date();
    order.receipt = {
      ...(order.receipt?.toObject?.() || order.receipt || {}),
      issuedAt: new Date().toISOString(),
      paymentMethod: order.paymentMethod,
      paymentProvider: "paymongo",
      paymentReference:
        event.paymentId ||
        event.paymentIntentId ||
        event.checkoutSessionId ||
        order.paymongo.referenceNumber ||
        "",
      paymentStatus: "paid",
      amountPaid: Number(order.totalAmount || 0),
      subtotalAmount: Number(order.subtotalAmount || 0),
      vatAmount: Number(order.vatAmount || 0),
      shippingFee: Number(order.shippingFee || 0),
      discountAmount: Number(order.discountAmount || 0),
    };
    if (order.workflowStatus === "to_pay") {
      await applyOrderLifecycleAction(order, "approve");
    } else {
      await order.save();
    }
    await createOrderNotification({
      customerId: order.customer,
      title: "Payment received",
      message: `Your payment for order ${order.orderCode} was received through PayMongo.`,
    });
    return order;
  }

  if (isFailed) {
    // Do not let a delayed failure callback roll back an order that has
    // already been paid and moved beyond checkout. PayMongo can deliver
    // callbacks out of order, so the server's current lifecycle wins.
    if (
      String(order.paymentStatus || "").toLowerCase() === "paid" &&
      order.workflowStatus !== "to_pay"
    ) {
      await order.save();
      return order;
    }
    const eventStatus = String(event.attributes?.status || "").toLowerCase();
    const eventPaymentStatus = String(event.attributes?.payment_status || "").toLowerCase();
    const nextPaymentStatus =
      eventStatus === "expired" || eventPaymentStatus === "expired"
        ? "expired"
        : eventType.includes("cancel") ||
            ["cancelled", "canceled"].includes(eventStatus) ||
            ["cancelled", "canceled"].includes(eventPaymentStatus)
          ? "cancelled"
          : "failed";
    order.paymentStatus = nextPaymentStatus;
    await releaseOrderInventoryOnce(
      order,
      `PayMongo payment ${nextPaymentStatus}.`,
    );
    order.receipt = {
      ...(order.receipt?.toObject?.() || order.receipt || {}),
      paymentMethod: order.paymentMethod,
      paymentProvider: "paymongo",
      paymentReference:
        event.paymentId ||
        event.paymentIntentId ||
        event.checkoutSessionId ||
        order.paymongo.referenceNumber ||
        "",
      paymentStatus: nextPaymentStatus,
      amountPaid: 0,
      subtotalAmount: Number(order.subtotalAmount || 0),
      vatAmount: Number(order.vatAmount || 0),
      shippingFee: Number(order.shippingFee || 0),
      discountAmount: Number(order.discountAmount || 0),
    };
    await order.save();
    await createOrderNotification({
      customerId: order.customer,
      title: "Payment not completed",
      message: `Payment for order ${order.orderCode} was not completed. You may try paying again from your order details.`,
    });
    return order;
  }

  await order.save();
  return order;
};

const checkoutSessionLooksPaid = (session = {}) => {
  const attributes = session?.data?.attributes || session?.attributes || {};
  const status = String(attributes.status || "").toLowerCase();
  const paymentStatus = String(attributes.payment_status || "").toLowerCase();
  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  return (
    ["paid", "succeeded", "completed"].includes(status) ||
    ["paid", "succeeded", "completed"].includes(paymentStatus) ||
    payments.some((payment) =>
      ["paid", "succeeded"].includes(
        String(payment?.attributes?.status || payment?.status || "").toLowerCase(),
      ),
    )
  );
};

const checkoutSessionLooksClosed = (session = {}) => {
  const attributes = session?.data?.attributes || session?.attributes || {};
  const status = String(attributes.status || "").toLowerCase();
  const paymentStatus = String(attributes.payment_status || "").toLowerCase();
  return ["failed", "expired", "cancelled", "canceled"].includes(status) ||
    ["failed", "expired", "cancelled", "canceled"].includes(paymentStatus);
};

const buildEventFromCheckoutSession = (session = {}) => {
  const data = session?.data || {};
  const attributes = data.attributes || {};
  const metadata = attributes.metadata || {};
  const payment = Array.isArray(attributes.payments) ? attributes.payments[0] : null;
  return {
    eventType: checkoutSessionLooksPaid(session)
      ? "checkout_session.payment.paid"
      : checkoutSessionLooksClosed(session)
        ? "checkout_session.expired"
        : "checkout_session.updated",
    resourceId: String(data.id || ""),
    resourceType: String(data.type || "checkout_session"),
    attributes,
    metadata,
    paymentId: String(payment?.id || payment?.attributes?.payment_id || ""),
    paymentIntentId: String(attributes.payment_intent?.id || attributes.payment_intent || ""),
    checkoutSessionId: String(data.id || ""),
    orderId: String(metadata.order_id || ""),
    orderCode: String(metadata.order_code || attributes.reference_number || ""),
  };
};

const hydrateOrdersWithInventoryQrCodes = async (orders = []) => {
  const orderList = Array.isArray(orders) ? orders : [orders];
  const responses = orderList.map(orderToResponse);
  const serialNumbers = Array.from(
    new Set(
      responses.flatMap((order) =>
        (order.items || []).flatMap((item) => collectItemSerialNumbers(item)),
      ),
    ),
  );
  const serialNumberSet = new Set(serialNumbers);
  const orderCodes = Array.from(
    new Set(
      responses
        .map((order) => String(order.orderCode || "").trim())
        .filter(Boolean),
    ),
  );
  const orderIds = Array.from(
    new Set(
      responses
        .map((order) => String(order.id || order._id || "").trim())
        .filter(Boolean),
    ),
  );

  const inventoryQueries = [];
  if (serialNumbers.length > 0) {
    inventoryQueries.push({
      "serialUnits.serialNumber": { $in: serialNumbers },
    });
  }
  if (orderCodes.length > 0) {
    inventoryQueries.push({
      "serialUnits.assignedOrderCode": { $in: orderCodes },
    });
  }
  if (orderIds.length > 0) {
    inventoryQueries.push({
      "serialUnits.assignedOrderId": { $in: orderIds },
    });
  }

  if (inventoryQueries.length === 0) return responses;

  const products = await Product.find({ $or: inventoryQueries }).select(
    "name sku serialUnits",
  );

  const inventoryUnitBySerial = new Map();
  const assignedInventoryUnits = new Map();
  const addAssignedInventoryUnit = (assignmentKey, unit) => {
    if (!assignmentKey) return;
    const existingUnits = assignedInventoryUnits.get(assignmentKey) || [];
    if (!existingUnits.some((existing) => existing.serialNumber === unit.serialNumber)) {
      existingUnits.push(unit);
    }
    assignedInventoryUnits.set(assignmentKey, existingUnits);
  };

  products.forEach((product) => {
    const productId = String(product._id || product.id || "");
    const productSku = String(product.sku || "").trim();
    const productName = String(product.name || "").trim();
    (product.serialUnits || []).forEach((unit) => {
      const serialNumber = String(unit.serialNumber || "").trim();
      if (!serialNumber) return;

      const inventoryUnit = {
        serialNumber,
        qrCode:
          String(unit.qrCode || "").trim() ||
          buildSerialQrCode(product, serialNumber),
        branch: String(unit.branch || "").trim(),
        status: String(unit.status || "").trim(),
        productId,
        productSku,
        productName,
      };

      if (serialNumberSet.has(serialNumber)) {
        inventoryUnitBySerial.set(serialNumber, inventoryUnit);
      }

      const assignedOrderCode = String(unit.assignedOrderCode || "").trim();
      const assignedOrderId = String(unit.assignedOrderId || "").trim();
      [assignedOrderCode, assignedOrderId].filter(Boolean).forEach((orderKey) => {
        [productId, productSku, productName.toLowerCase()]
          .filter(Boolean)
          .forEach((productKey) =>
            addAssignedInventoryUnit(`${orderKey}:${productKey}`, inventoryUnit),
          );
      });
    });
  });

  responses.forEach((order) => {
    order.items = (order.items || []).map((item) => {
      const existingUnits = Array.isArray(item.serialUnits)
        ? item.serialUnits
        : [];
      const existingUnitBySerial = new Map(
        existingUnits
          .map((unit) => [
            String(unit?.serialNumber || "").trim(),
            unit,
          ])
          .filter(([serialNumber]) => Boolean(serialNumber)),
      );
      let itemSerialNumbers = collectItemSerialNumbers(item);
      if (itemSerialNumbers.length === 0) {
        const itemProductKeys = [
          String(item.productId || "").trim(),
          String(item.sku || item.model || "").trim(),
          String(item.name || "").trim().toLowerCase(),
        ].filter(Boolean);
        const orderKeys = [
          String(order.orderCode || "").trim(),
          String(order.id || order._id || "").trim(),
        ].filter(Boolean);
        const assignedUnits = [];

        orderKeys.forEach((orderKey) => {
          itemProductKeys.forEach((productKey) => {
            (assignedInventoryUnits.get(`${orderKey}:${productKey}`) || [])
              .forEach((unit) => {
                if (
                  !assignedUnits.some(
                    (existing) => existing.serialNumber === unit.serialNumber,
                  )
                ) {
                  assignedUnits.push(unit);
                }
              });
          });
        });

        itemSerialNumbers = assignedUnits
          .slice(0, Number(item.quantity || assignedUnits.length) || assignedUnits.length)
          .map((unit) => unit.serialNumber);
        assignedUnits.forEach((unit) => {
          inventoryUnitBySerial.set(unit.serialNumber, unit);
        });
      }
      const hydratedUnits = itemSerialNumbers.map((serialNumber) => {
        const existingUnit = existingUnitBySerial.get(serialNumber) || {};
        const inventoryUnit = inventoryUnitBySerial.get(serialNumber) || {};

        return {
          serialNumber,
          qrCode:
            String(existingUnit.qrCode || "").trim() ||
            inventoryUnit.qrCode ||
            "",
          branch:
            inventoryUnit.branch ||
            String(existingUnit.branch || "").trim() ||
            String(item.sourceBranch || "").trim(),
          status:
            inventoryUnit.status ||
            String(existingUnit.status || "").trim(),
          productId:
            inventoryUnit.productId ||
            String(item.productId || "").trim(),
          productSku: inventoryUnit.productSku || "",
          productName:
            inventoryUnit.productName ||
            String(item.name || "").trim(),
        };
      });

      return {
        ...item,
        serialNumbers: itemSerialNumbers,
        serialUnits: hydratedUnits,
      };
    });
  });

  return responses;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const createOrderNotification = async ({ customerId, title, message }) => {
  if (!customerId || !title || !message) return;
  try {
    const user = await User.findById(customerId).select("notifications");
    const notifications =
      user?.notifications?.toObject?.() || user?.notifications || {};
    if (
      notifications.inApp === false ||
      notifications.push === false ||
      notifications.orderUpdates === false
    ) {
      return;
    }

    await Notification.create({
      user: customerId,
      type: "order",
      title,
      message,
      unread: true,
      status: "unread",
    });
  } catch (error) {
    console.error("Failed to create order notification:", error);
  }
};

const createStaffOrderNotification = async ({ order, title, message }) => {
  if (!order || !title || !message) return;
  try {
    const branch = String(order.stockSourceBranch || order.customerBranch || "").trim();
    const branchFilter = branch
      ? [
          { role: "superadmin" },
          { activeBranch: branch },
          { assignedBranch: branch },
          { activeBranch: "" },
          { assignedBranch: "" },
          { activeBranch: { $exists: false } },
          { assignedBranch: { $exists: false } },
        ]
      : [{ role: { $in: ["admin", "superadmin", "manager", "owner"] } }];
    const staff = await User.find({
      role: { $in: ["admin", "superadmin", "manager", "owner"] },
      isDeleted: { $ne: true },
      accountStatus: { $ne: "deleted" },
      $or: branchFilter,
    }).select("_id notifications");
    const notifications = staff
      .filter((user) => {
        const prefs = user.notifications?.toObject?.() || user.notifications || {};
        return prefs.inApp !== false && prefs.push !== false && prefs.orderUpdates !== false;
      })
      .map((user) => ({
        user: user._id,
        type: "order",
        title,
        message,
      }));
    if (notifications.length > 0) await Notification.insertMany(notifications);
  } catch (error) {
    console.warn("Failed to notify staff about order:", error);
  }
};

const canReceiveNotification = (user, type = "system") => {
  const notifications =
    user?.notifications?.toObject?.() || user?.notifications || {};
  if (notifications.inApp === false || notifications.push === false) return false;
  if (type === "order" && notifications.orderUpdates === false) return false;
  if (type === "system" && notifications.systemAlerts === false) return false;
  if (type === "account" && notifications.accountUpdates === false) return false;
  return true;
};

const notifyBranchAdminsForOrder = async (order) => {
  if (!order?.orderCode) return;
  try {
    const branch = order.stockSourceBranch || order.customerBranch || "";
    const staffRoles = ["admin", "superadmin", "manager", "owner"];
    const branchFilters = branch
      ? [
          { assignedBranch: branch },
          { activeBranch: branch },
          { assignedBranch: "" },
          { activeBranch: "" },
          { assignedBranch: { $exists: false } },
          { activeBranch: { $exists: false } },
        ]
      : [{}];
    const staff = await User.find({
      role: { $in: staffRoles },
      accountStatus: { $ne: "disabled" },
      $or: [{ role: "superadmin" }, ...branchFilters],
    }).select("_id notifications");

    const notifications = staff
      .filter((user) => canReceiveNotification(user, "order"))
      .map((user) => ({
        user: user._id,
        type: "order",
        title: "New customer order",
        message: `Order ${order.orderCode} from ${order.customerName || "a customer"} is waiting in Admin Orders.`,
        unread: true,
        status: "unread",
      }));

    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }
  } catch (error) {
    console.error("Failed to notify branch admins:", error);
  }
};

const notifyBranchTechnicians = async (branch, orderCode) => {
  if (!branch || !orderCode) return;
  try {
    const technicians = await User.find({
      role: "technician",
      $or: [
        { assignedBranch: branch },
        { activeBranch: branch },
        { assignedBranch: "" },
        { activeBranch: "" },
      ],
    }).select("_id notifications");

    const validNotifications = technicians
      .filter((tech) => canReceiveNotification(tech, "system"))
      .map((tech) => ({
        user: tech._id,
        type: "system",
        title: "New technician task available",
        message: `A new task for order ${orderCode} is available in your task board.`,
        unread: true,
        status: "unread",
      }));

    if (validNotifications.length > 0) {
      await Notification.insertMany(validNotifications);
    }
  } catch (error) {
    console.error("Failed to notify technicians:", error);
  }
};

const notifyAssignedTechnician = async (technicianId, orderCode, taskCode) => {
  if (!technicianId) return;
  try {
    const technician = await User.findById(technicianId).select("notifications");
    if (!technician || !canReceiveNotification(technician, "system")) return;
    await Notification.create({
      user: technician._id,
      type: "system",
      title: "Work order assigned to you",
      message: `Order ${orderCode} is assigned to you${taskCode ? ` (${taskCode})` : ""}. Open My Work to review it.`,
      unread: true,
      status: "unread",
    });
  } catch (error) {
    console.error("Failed to notify assigned technician:", error);
  }
};

const getUserDisplayName = (user = {}) =>
  user.name ||
  `${user.name_first || ""} ${user.name_last || ""}`.trim() ||
  user.email ||
  "";

const resolveTechnicianAssignment = async (options = {}) => {
  const technicianId = String(options.assignedTechnicianId || "").trim();
  const technicianName = String(options.assignedTechnicianName || options.assignedTechnician || "").trim();
  if (!technicianId) {
    return { assignedTechnicianId: "", assignedTechnicianName: technicianName };
  }

  const technician = await User.findOne({
    _id: technicianId,
    role: "technician",
    isDeleted: { $ne: true },
    accountStatus: { $nin: ["deleted", "disabled"] },
  }).select("name name_first name_last email");

  if (!technician) {
    throw new HttpError(404, "Selected technician was not found.");
  }

  return {
    assignedTechnicianId: String(technician._id || ""),
    assignedTechnicianName: getUserDisplayName(technician) || technicianName || "Technician",
  };
};

const buildOrderTaskItems = (order = {}) =>
  (order.items || []).map((item) => {
    const serialUnits = Array.isArray(item.serialUnits)
      ? item.serialUnits.map((unit) => ({
          serialNumber: String(unit?.serialNumber || "").trim(),
          qrCode: String(unit?.qrCode || "").trim(),
        }))
      : [];
    const serialNumbers = Array.from(
      new Set(
        [
          ...(Array.isArray(item.serialNumbers) ? item.serialNumbers : []),
          ...serialUnits.map((unit) => unit.serialNumber),
        ]
          .map((serial) => String(serial || "").trim())
          .filter(Boolean),
      ),
    );

    return {
      productId: String(item.productId || "").trim(),
      name: String(item.name || "AC Unit").trim(),
      price: Number(item.price || 0),
      quantity: Number(item.quantity || 1),
      specs: String(item.specs || "").trim(),
      sourceBranch: String(item.sourceBranch || order.stockSourceBranch || "").trim(),
      serialNumbers,
      serialUnits,
    };
  });

const buildOrderTaskAddress = (order = {}) =>
  [
    order.address?.street,
    order.address?.barangay,
    order.address?.city,
    order.address?.province,
    order.address?.postalCode,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");

const createTaskForOrder = async (order, options = {}) => {
  if (!order) return null;
  const existingTask = await findLinkedTaskForOrder(order);
  const assignment = await resolveTechnicianAssignment(options);
  const taskItems = buildOrderTaskItems(order);
  const taskSerialNumbers = Array.from(
    new Set(
      taskItems
        .flatMap((item) => item.serialNumbers)
        .map((serial) => String(serial || "").trim())
        .filter(Boolean),
    ),
  );
  const taskQrCodes = Array.from(
    new Set(
      taskItems
        .flatMap((item) => item.serialUnits || [])
        .map((unit) => String(unit.qrCode || "").trim())
        .filter(Boolean),
    ),
  );
  if (existingTask) {
    let changed = false;
    if (assignment.assignedTechnicianId || assignment.assignedTechnicianName) {
      existingTask.assignedTechnicianId =
        assignment.assignedTechnicianId || existingTask.assignedTechnicianId;
      existingTask.assignedTechnicianName =
        assignment.assignedTechnicianName || existingTask.assignedTechnicianName;
      changed = true;
    }
    if (options.installationDate || options.estimatedArrival) {
      existingTask.scheduledDate = String(
        options.installationDate ||
          options.estimatedArrival ||
          existingTask.scheduledDate ||
          "",
      );
      changed = true;
    }
    if (options.timeSlot) {
      existingTask.timeSlot = String(options.timeSlot);
      changed = true;
    }
    if (options.forceRefreshTask) changed = true;
    if (changed) {
      existingTask.payload = {
        ...(existingTask.payload || {}),
        orderId: order.id,
        orderCode: order.orderCode,
        items: taskItems,
        serialNumbers: taskSerialNumbers,
        qrCodes: taskQrCodes,
        customerAddress: order.address,
        customerName: order.customerName,
        customerPhone: String(order.address.phone || ""),
        assignedTechnicianId: existingTask.assignedTechnicianId,
        assignedTechnicianName: existingTask.assignedTechnicianName,
        scheduledDate: existingTask.scheduledDate,
        timeSlot: existingTask.timeSlot,
        orderWorkflowStatus: order.workflowStatus,
        deliveryStatus: order.deliveryStatus || "",
        dispatchedAt: order.dispatchedAt || null,
        updatedAt: new Date().toISOString(),
      };
      await existingTask.save();
      if (assignment.assignedTechnicianId) {
        await notifyAssignedTechnician(
          assignment.assignedTechnicianId,
          order.orderCode,
          existingTask.taskCode,
        );
      }
    }
    return existingTask;
  }

  const branch = order.stockSourceBranch || "";
  const addressText = buildOrderTaskAddress(order);
  const itemNames = taskItems.map((item) => item.name).filter(Boolean).join(", ");

  const task = await Task.create({
    taskCode: `TSK-${Date.now()}`,
    title: `Fulfill ${order.orderCode}`,
    customer: order.customerName,
    address: addressText || order.address.name || "Customer address",
    customerId: String(order.customer || ""),
    customerEmail: "",
    customerPhone: String(order.address.phone || ""),
    unitId: "",
    unitName: itemNames || `Order ${order.orderCode}`,
    unitType: "order",
    issueType: "Order Fulfillment",
    description: `Deliver and install items for order ${order.orderCode}.`,
    assignedTechnicianId: assignment.assignedTechnicianId,
    assignedTechnicianName: assignment.assignedTechnicianName,
    status: "pending",
    priority: "medium",
    scheduledDate:
      options.installationDate ||
      order.installationDate ||
      order.estimatedDelivery ||
      new Date().toISOString().split("T")[0],
    timeSlot: String(options.timeSlot || "TBD"),
    assignedRole: "technician",
    branch,
    payload: {
      orderId: order.id,
      orderCode: order.orderCode,
      items: taskItems,
      serialNumbers: taskSerialNumbers,
      qrCodes: taskQrCodes,
      customerAddress: order.address,
      customerName: order.customerName,
      customerPhone: String(order.address.phone || ""),
      assignedTechnicianId: assignment.assignedTechnicianId,
      assignedTechnicianName: assignment.assignedTechnicianName,
      orderWorkflowStatus: order.workflowStatus,
      deliveryStatus: order.deliveryStatus || "",
      dispatchedAt: order.dispatchedAt || null,
      scheduledDate:
        options.installationDate ||
        order.installationDate ||
        order.estimatedDelivery ||
        "",
      timeSlot: String(options.timeSlot || "TBD"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  if (assignment.assignedTechnicianId) {
    await notifyAssignedTechnician(assignment.assignedTechnicianId, order.orderCode, task.taskCode);
  } else {
    await notifyBranchTechnicians(branch, order.orderCode);
  }
  return task;
};

const findLinkedTaskForOrder = (order) =>
  Task.findOne({
    $or: [
      { "payload.orderId": String(order._id || order.id || "") },
      { "payload.orderCode": order.orderCode },
    ],
  });

const parseCapacityHp = (value = "") => {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
};

const findProductSerialUnit = async (serialNumber) => {
  const escapedSerial = String(serialNumber || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const product = await Product.findOne({
    "serialUnits.serialNumber": new RegExp(`^${escapedSerial}$`, "i"),
  }).select("-imageData");

  if (!product) return { product: null, serialUnit: null };
  const serialUnit = (product.serialUnits || []).find(
    (unit) =>
      String(unit.serialNumber || "").toLowerCase() ===
      String(serialNumber || "").toLowerCase(),
  );
  return { product, serialUnit };
};

const getTaskSerialNumbers = (task) => {
  const payload = task?.payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const directSerials = Array.isArray(payload.serialNumbers) ? payload.serialNumbers : [];
  return Array.from(
    new Set(
      [...directSerials, ...items
        .flatMap((item) => [
          ...(Array.isArray(item.serialNumbers) ? item.serialNumbers : []),
          ...(Array.isArray(item.serialUnits)
            ? item.serialUnits.map((unit) => unit?.serialNumber)
            : []),
        ])]
        .map((serial) => String(serial || "").trim())
        .filter(Boolean),
    ),
  );
};

const getAmpRegistrations = (task) => {
  const registrations = task?.payload?.ampRegistrations;
  return registrations && typeof registrations === "object" && !Array.isArray(registrations)
    ? registrations
    : {};
};

const getTaskCompletionBlocker = (order, linkedTask) => {
  if (!linkedTask) {
    return `Order ${order.orderCode} has no linked technician task yet. Use Repair Task, then complete the technician workflow.`;
  }

  const registrations = getAmpRegistrations(linkedTask);
  const requiredSerials = getTaskSerialNumbers(linkedTask);
  const pendingSerials = requiredSerials.filter(
    (serial) => registrations[serial]?.status !== "registered",
  );
  if (pendingSerials.length > 0) {
    return `Order ${order.orderCode} still needs AMP QR registration for ${pendingSerials.join(", ")}.`;
  }

  if (String(linkedTask.status || "").toLowerCase() !== "completed") {
    return `Order ${order.orderCode} is waiting for technician task ${linkedTask.taskCode || linkedTask.id} to be completed.`;
  }

  const proof = linkedTask.proof || linkedTask.payload?.proof || {};
  const hasInstallationPhoto = (proof?.afterPhotos || []).some((photo) =>
    Boolean(String(photo?.uri || "").trim()),
  );
  const hasCustomerSignoff = Boolean(String(proof?.customerSignature?.name || "").trim());
  const hasWorkSummary = Boolean(
    String(linkedTask.payload?.findings || linkedTask.payload?.resolution || "").trim(),
  );
  if (!hasInstallationPhoto || !hasCustomerSignoff || !hasWorkSummary) {
    return `Order ${order.orderCode} needs a technician work summary, installed-unit photo, and customer or receiver sign-off before it can be closed.`;
  }

  return "";
};

const syncInstalledUnitsFromTask = async (task) => {
  const registrations = getAmpRegistrations(task);
  const registeredSerials = getTaskSerialNumbers(task).filter(
    (serial) => registrations[serial]?.status === "registered",
  );
  const installedUnits = [];

  for (const serialNumber of registeredSerials) {
    const { product, serialUnit } = await findProductSerialUnit(serialNumber);
    if (!product || !serialUnit) continue;
    const registration = registrations[serialNumber] || {};
    const address = task.payload?.customerAddress || {};
    const ampParameters = registration.ampParameters || {};
    const nextServiceDate = registration.ampServicePlan?.nextServiceDate
      ? new Date(registration.ampServicePlan.nextServiceDate)
      : null;
    const customerId = String(task.customerId || task.payload?.customerId || "").trim();
    if (!customerId) continue;

    const installed = await Unit.findOneAndUpdate(
      { serialNumber: serialUnit.serialNumber },
      {
        $set: {
          serialNumber: serialUnit.serialNumber,
          qrCode: String(serialUnit.qrCode || ""),
          productId: String(product._id || product.id || ""),
          modelName: [product.name, product.specs].filter(Boolean).join(" ") || product.sku || "AC Unit",
          brand: String(product.brand || ""),
          capacityHp: parseCapacityHp(product.specs),
          customer: customerId,
          customerName: String(task.customer || task.payload?.customerName || ""),
          installation: {
            installedAt: ampParameters.installationDate
              ? new Date(ampParameters.installationDate)
              : new Date(),
            installedBy: task.assignedTechnicianId || registration.technicianId || undefined,
            addressLine: String(address.street || task.address || ""),
            city: String(address.city || ""),
            province: String(address.province || ""),
            zipCode: String(address.postalCode || address.zipCode || "0000"),
            coordinates: {},
          },
          amp: {
            currentHealthScore: 100,
            serviceThreshold: 60,
            dailyBaseDecay: 0.22,
            historicalCurveFactor: 1,
            nextIdealServicePeriod: String(registration.ampServicePlan?.label || ""),
            nextIdealServiceDate:
              nextServiceDate && !Number.isNaN(nextServiceDate.getTime())
                ? nextServiceDate
                : null,
            lastCalculatedAt: new Date(),
          },
          status: "active",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (installed) installedUnits.push(installed);
  }

  return installedUnits;
};

const createOrder = async (req, res) => {
  const user = req.authUser;
  res.set("X-AeroPulse-Order-Controller", "mobile-order-bridge-2026-05-25");
  const {
    items = [],
    address = {},
    addressId = "",
    paymentMethod = "cod",
    total = 0,
    subtotal = 0,
    subtotalAmount = 0,
    vatAmount = 0,
    taxAmount = 0,
    shippingFee = 0,
    deliveryFee = 0,
    discountAmount = 0,
    paymentReturnTarget = "",
    returnTarget = "",
    clientType = "",
    platform = "",
    idempotencyKey: bodyIdempotencyKey = "",
  } = req.body;
  const idempotencyKey = String(
    req.get("Idempotency-Key") || bodyIdempotencyKey || "",
  ).trim().slice(0, 160);

  if (idempotencyKey) {
    const existingOrder = await Order.findOne({
      customer: user._id,
      idempotencyKey,
    });
    if (existingOrder) {
      const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([existingOrder]);
      return res.status(200).json({
        order: {
          ...hydratedOrder,
          paymentUrl: hydratedOrder.paymongo?.checkoutUrl || "",
        },
        payment: hydratedOrder.paymongo?.checkoutUrl
          ? {
              provider: "paymongo",
              checkoutSessionId: hydratedOrder.paymongo?.checkoutSessionId || "",
              checkoutUrl: hydratedOrder.paymongo.checkoutUrl,
              status: hydratedOrder.paymongo?.status || "active",
            }
          : null,
        idempotentReplay: true,
      });
    }
  }
  const usesOnlinePayment = isOnlinePaymentMethod(paymentMethod);
  const checkoutReturnTarget = normalizePaymentReturnTarget(
    paymentReturnTarget || returnTarget || clientType || platform,
  );
  const savedAddresses = Array.isArray(user.addresses)
    ? user.addresses.map((item) => normalizeAddress(item))
    : [];
  const userProfileAddress = user.billingAddress?.toObject?.() || user.billingAddress || {};
  const userLocationAddress =
    user.location?.address?.toObject?.() || user.location?.address || {};
  const fallbackLegacyAddress = normalizeAddress({
    name:
      user.name || `${user.name_first || ""} ${user.name_last || ""}`.trim(),
    phone: user.phone || "",
    street: userProfileAddress.street || userLocationAddress.street || user.address || "",
    barangay: userProfileAddress.barangay || userLocationAddress.barangay || "",
    city: userProfileAddress.city || userLocationAddress.city || "",
    province: userProfileAddress.province || userLocationAddress.province || "",
    region: userProfileAddress.region || userLocationAddress.region || "",
    postalCode: userLocationAddress.postalCode || "",
  });
  const payloadAddress = mergeAddress(normalizeAddress(address), {
    name:
      user.name || `${user.name_first || ""} ${user.name_last || ""}`.trim(),
    phone: user.phone || "",
  });

  const normalizedAddress = ensureOrderAddress((() => {
    const requestedId = String(
      addressId || address.id || address._id || "",
    ).trim();
    if (requestedId) {
      const matchedById = savedAddresses.find(
        (item) => String(item._id || "") === requestedId,
      );
      if (matchedById) {
        // A selected saved address is authoritative. Client profile data can
        // be stale after the customer edits their address in another session.
        if (isValidAddress(matchedById)) return matchedById;
      }
    }

    if (isValidAddress(payloadAddress)) return payloadAddress;

    if (savedAddresses.length > 0) {
      const matchedByFields = savedAddresses.find(
        (item) =>
          item.street === payloadAddress.street &&
          item.city === payloadAddress.city &&
          item.phone === payloadAddress.phone &&
          item.name === payloadAddress.name,
      );
      if (matchedByFields) {
        const mergedByFields = mergeAddress(matchedByFields, payloadAddress);
        if (isValidAddress(mergedByFields)) return mergedByFields;
      }
      const defaultAddress = savedAddresses.find((item) => item.isDefault);
      const mergedDefault = mergeAddress(defaultAddress || savedAddresses[0], payloadAddress);
      if (isValidAddress(mergedDefault)) return mergedDefault;
    }

    return fallbackLegacyAddress;
  })(), user);

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Order items are required." });
  }
  try {
    await ensureSampleInventory();
  } catch (error) {
    console.error("Failed to prepare product inventory for order:", error);
  }
  if (!isValidAddress(normalizedAddress)) {
    console.warn("Order created with incomplete mobile checkout address", {
      userId: String(user._id || ""),
      reason: getAddressValidationMessage(normalizedAddress),
      address: {
        name: normalizedAddress.name,
        phone: normalizedAddress.phone,
        street: normalizedAddress.street,
        barangay: normalizedAddress.barangay,
        city: normalizedAddress.city,
      },
    });
  }

  // A timestamp alone can collide when two customers submit at the same
  // millisecond. The suffix keeps every transaction and serial reservation
  // independently traceable.
  const orderCode = `ORD-${Date.now()}-${randomSerialToken()}`;
  const receiptNumber = `RCP-${Date.now()}`;
  const trackingNumber = `TRK-${Math.floor(Math.random() * 1000000000)}`;
  const eta = new Date();
  eta.setDate(eta.getDate() + 7);
  const installDate = new Date(eta);
  installDate.setDate(installDate.getDate() + 1);

  const preferredBranch = resolvePreferredBranch(normalizedAddress);
  const branchSearchOrder = getBranchSearchOrder(preferredBranch);
  const assignedTechnician = preferredBranch
    ? `${preferredBranch} Technician Team`
    : "";

  const createOrderDocument = async (session = null) => {
    const resolvedItems = [];
    const completedReservations = [];
    let lastSourceBranch = null;
    try {
      for (const item of items) {
        const quantityNeeded = Number(item.quantity) || 0;
        if (quantityNeeded < 1) {
          throw new HttpError(400, "Invalid cart item payload.");
        }

        const product = await resolveProductForOrderItem(item, session);
        if (!product) {
          throw new HttpError(
            404,
            `Product not found: ${item.name || item.productId || item.id || item.model || item.sku}`,
          );
        }

        const selectedBranch = branchSearchOrder.find((branch) =>
          Number(product.branchStock?.get(branch) || 0) >= quantityNeeded,
        );
        const hasBranchSnapshot = branchSearchOrder.some(
          (branch) => Number(product.branchStock?.get(branch) || 0) > 0,
        );
        const fallbackBranch =
          !hasBranchSnapshot && Number(product.stock || 0) >= quantityNeeded
            ? preferredBranch
            : null;
        const finalBranch = selectedBranch || fallbackBranch;

        if (!finalBranch) {
          throw new HttpError(
            409,
            `Insufficient branch stock for ${product.name}. Tried preferred and nearby branches.`,
          );
        }

        lastSourceBranch = finalBranch;
        const serialUnits = await reserveSerialUnitsForOrder(
          product,
          finalBranch,
          quantityNeeded,
          orderCode,
          session,
        );
        const serialNumbers = serialUnits.map((unit) => unit.serialNumber);
        try {
          await decrementProductStockForOrder(
            product,
            finalBranch,
            quantityNeeded,
            hasBranchSnapshot,
            session,
          );
        } catch (error) {
          await releaseReservedSerialUnits(product._id, serialNumbers, session);
          throw error;
        }

        completedReservations.push({
          productId: product._id,
          branch: finalBranch,
          quantity: quantityNeeded,
          hasBranchSnapshot,
          serialNumbers,
        });
        resolvedItems.push({
          productId: String(product.id || ""),
          name: product.name,
          price: Number(product.price || 0),
          quantity: quantityNeeded,
          specs: product.specs || "",
          serialNumbers,
          serialUnits,
          sourceBranch: finalBranch,
        });
      }
    } catch (error) {
      // Atlas transactions roll back automatically. A development or legacy
      // Mongo deployment may not support transactions, so compensate every
      // earlier reservation before reporting a failed order.
      if (!session) {
        await Promise.allSettled(
          completedReservations.reverse().map(async (reservation) => {
            await restoreReservedProductStock(
              reservation.productId,
              reservation.branch,
              reservation.quantity,
              reservation.hasBranchSnapshot,
            );
            await releaseReservedSerialUnits(
              reservation.productId,
              reservation.serialNumbers,
            );
          }),
        );
      }
      throw error;
    }

    const itemsSummary = resolvedItems
      .map((item) => `${item.name} x${item.quantity}`)
      .join(", ");
    const stockSourceBranch = lastSourceBranch || preferredBranch;
    const serverTotals = calculateOrderTotals(resolvedItems, stockSourceBranch);
    const normalizedSubtotal = serverTotals.subtotal;
    const normalizedVat = serverTotals.vatAmount;
    const normalizedShipping = serverTotals.shippingFee;
    const normalizedDiscount = serverTotals.discountAmount;
    const normalizedTotal = serverTotals.total;
    const orderPayload = {
      orderCode,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      customer: user._id,
      customerName: user.name || `${user.name_first} ${user.name_last}`.trim(),
      items: resolvedItems,
      address: normalizedAddress,
      paymentMethod,
      paymentProvider: usesOnlinePayment ? "paymongo" : "",
      paymentStatus: usesOnlinePayment ? "pending" : "not_required",
      trackingNumber,
      estimatedDelivery: eta.toISOString().split("T")[0],
      estimatedArrival: eta.toISOString(),
      installationDate: installDate.toISOString(),
      assignedTechnician,
      customerBranch: preferredBranch,
      stockSourceBranch,
      receipt: {
        receiptNumber,
        issuedAt: new Date().toISOString(),
        paymentMethod,
        paymentProvider: usesOnlinePayment ? "paymongo" : "",
        paymentReference: "",
        paymentStatus: usesOnlinePayment ? "pending" : "not_required",
        amountPaid: normalizedTotal,
        subtotalAmount: normalizedSubtotal,
        vatAmount: normalizedVat,
        shippingFee: normalizedShipping,
        discountAmount: normalizedDiscount,
        itemsSummary,
      },
      subtotalAmount: normalizedSubtotal,
      vatAmount: normalizedVat,
      shippingFee: normalizedShipping,
      discountAmount: normalizedDiscount,
      totalAmount: normalizedTotal,
      workflowStatus: "to_pay",
      status: "pending",
      stockReservationStatus: "reserved",
    };

    if (!session) return Order.create(orderPayload);
    const created = await Order.create([orderPayload], { session });
    return Array.isArray(created) ? created[0] : created;
  };

  const isTransactionUnsupportedError = (error) => {
    const message = String(error?.message || "");
    return (
      message.includes("Transaction numbers are only allowed") ||
      message.includes("replica set member or mongos") ||
      message.includes("Cannot use a session that has ended") ||
      message.includes("This MongoDB deployment does not support retryable writes")
    );
  };

  const attemptCreateOrder = async () => {
    const session = await mongoose.startSession();
    try {
      let createdOrder = null;
      await session.withTransaction(async () => {
        createdOrder = await createOrderDocument(session);
      });
      return createdOrder;
    } catch (error) {
      if (!isTransactionUnsupportedError(error)) throw error;
      console.warn("Mongo transactions unavailable; creating order without transaction.");
      return createOrderDocument(null);
    } finally {
      await session.endSession();
    }
  };

  const isRetryableTransactionError = (error) => {
    const message = String(error?.message || "");
    return (
      message.includes("WriteConflict") ||
      message.includes("TransientTransactionError")
    );
  };

  try {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let order = null;
      let checkout = null;
      try {
        order = await attemptCreateOrder();
        if (usesOnlinePayment) {
          checkout = await attachPaymongoCheckout(order, {
            req,
            returnTarget: checkoutReturnTarget,
          });
        }
        await createOrderNotification({
          customerId: user._id,
          title: "Order received",
          message: usesOnlinePayment
            ? `Your order ${order.orderCode} has been received. Complete your PayMongo payment to continue processing.`
            : `Your order ${order.orderCode} has been received and is now pending approval. You can track its status in My Orders.`,
        });
        await notifyBranchAdminsForOrder(order);

        // Send real email receipt
        if (canSendEmail()) {
          try {
            await sendEmail({
              to: user.email,
              subject: `Order Confirmation - ${order.orderCode}`,
              text: `Thank you for your order! Your order code is ${order.orderCode}. Total: ₱${Number(order.totalAmount || 0).toLocaleString()}`,
              html: `<h1>Thank you for your order!</h1><p>Your order code is <strong>${order.orderCode}</strong>.</p><p>Total Amount: ₱${Number(order.totalAmount || 0).toLocaleString()}</p>`,
            });
          } catch (emailErr) {
            console.error("Failed to send order email:", emailErr);
          }
        }

        const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
        return res.status(201).json({
          order: {
            ...hydratedOrder,
            paymentUrl: checkout?.checkoutUrl || hydratedOrder.paymongo?.checkoutUrl || "",
          },
          payment: checkout
            ? {
                provider: "paymongo",
                checkoutSessionId: checkout.id,
                checkoutUrl: checkout.checkoutUrl,
                status: checkout.status,
              }
            : null,
        });
      } catch (error) {
        // An online order reserves stock before the payment provider creates
        // its checkout session. Restore that reservation whenever PayMongo
        // cannot start, so the customer can retry without a silent, blocked
        // cart or an orphaned unpaid order.
        if (order && usesOnlinePayment && !checkout) {
          await rollbackUnpaidOnlineOrder(order);
        }
        if (error instanceof HttpError) {
          return res.status(error.status).json({ message: error.message });
        }
        if (error instanceof PaymongoError) {
          return res.status(error.status || 502).json({
            message: `Unable to start PayMongo checkout: ${error.message}`,
          });
        }
        lastError = error;
        if (!isRetryableTransactionError(error)) break;
      }
    }
    console.error("Failed to create order:", lastError);
    return res
      .status(500)
      .json({
        message:
          process.env.NODE_ENV === "production" || !lastError?.message
            ? "Unable to create order right now."
            : `Unable to create order right now: ${lastError.message}`,
      });
  } catch (error) {
    console.error("Failed to create order:", error);
    return res
      .status(500)
      .json({
        message:
          process.env.NODE_ENV === "production" || !error?.message
            ? "Unable to create order right now."
            : `Unable to create order right now: ${error.message}`,
      });
  }
};

const getOrderForAdminAction = async (req, orderId) => {
  const conditions = [{ orderCode: orderId }];
  if (mongoose.Types.ObjectId.isValid(orderId)) conditions.unshift({ _id: orderId });
  const baseQuery = { $or: conditions };
  const query = { ...baseQuery };
  if (req.authUser.role !== "superadmin" && req.activeBranch) {
    query.$and = [
      baseQuery,
      {
        $or: [
          { customerBranch: req.activeBranch },
          { stockSourceBranch: req.activeBranch },
        ],
      },
    ];
    delete query.$or;
  }
  return Order.findOne(query);
};

const applyOrderLifecycleAction = async (order, action, options = {}) => {
  const config = lifecycleActions[action];
  if (!config) {
    throw new HttpError(400, "Invalid action.");
  }
  if (["complete", "cancelled"].includes(order.workflowStatus)) {
    throw new HttpError(
      409,
      `Order ${order.orderCode} is already ${workflowLabel(order.workflowStatus)} and cannot be changed.`,
    );
  }
  if (!config.from.includes(order.workflowStatus)) {
    throw new HttpError(
      409,
      `Cannot ${action} order ${order.orderCode} while it is ${workflowLabel(order.workflowStatus)}.`,
    );
  }
  if (
    action === "approve" &&
    String(order.paymentProvider || "").toLowerCase() === "paymongo" &&
    String(order.paymentStatus || "").toLowerCase() !== "paid"
  ) {
    throw new HttpError(
      409,
      `Order ${order.orderCode} is waiting for PayMongo payment confirmation.`,
    );
  }
  if (action === "complete") {
    const linkedTask = await findLinkedTaskForOrder(order);
    const proof = linkedTask?.proof || linkedTask?.payload?.proof || {};
    const hasInstallationPhoto = (proof?.afterPhotos || []).some((photo) =>
      Boolean(String(photo?.uri || "").trim()),
    );
    const hasCustomerSignoff = Boolean(String(proof?.customerSignature?.name || "").trim());
    const hasWorkSummary = Boolean(
      String(linkedTask?.payload?.findings || linkedTask?.payload?.resolution || "").trim(),
    );
    if (!linkedTask || linkedTask.status !== "completed" || !hasInstallationPhoto || !hasCustomerSignoff || !hasWorkSummary) {
      throw new HttpError(
        409,
        getTaskCompletionBlocker(order, linkedTask) ||
          `Order ${order.orderCode} cannot be completed until the technician task is completed with proof.`,
      );
    }
  }

  const linkedTaskBeforeAction = action === "dispatch" ? await findLinkedTaskForOrder(order) : null;
  const assignmentOptions = action === "approve" || action === "dispatch" || options.assignedTechnicianId || options.assignedTechnicianName
    ? {
        ...options,
        assignedTechnicianId: options.assignedTechnicianId || order.assignedTechnicianId || linkedTaskBeforeAction?.assignedTechnicianId || "",
        assignedTechnicianName: options.assignedTechnicianName || order.assignedTechnician || linkedTaskBeforeAction?.assignedTechnicianName || "",
      }
    : options;
  const assignment = await resolveTechnicianAssignment(assignmentOptions);
  if (action === "dispatch" && !assignment.assignedTechnicianId) {
    throw new HttpError(400, "Assign a technician before marking this order dispatched. The technician work order must be created at dispatch.");
  }
  if (action === "dispatch" && linkedTaskBeforeAction && ["completed", "failed"].includes(String(linkedTaskBeforeAction.status || "").toLowerCase())) {
    throw new HttpError(409, `Order ${order.orderCode} has a ${linkedTaskBeforeAction.status} technician task and cannot be dispatched again.`);
  }

  order.workflowStatus = config.to;
  order.status = config.status;
  order.deliveryStatus = config.deliveryStatus || order.deliveryStatus;
  if (action === "dispatch") {
    order.dispatchedAt = order.dispatchedAt || new Date();
    order.dispatchedBy = options.actorUserId || null;
  }
  if (assignment.assignedTechnicianId) {
    order.assignedTechnicianId = assignment.assignedTechnicianId;
  }
  if (assignment.assignedTechnicianName || options.assignedTechnician) {
    order.assignedTechnician =
      assignment.assignedTechnicianName ||
      String(options.assignedTechnician || "").trim();
  }
  if (options.estimatedArrival) order.estimatedArrival = options.estimatedArrival;
  if (options.installationDate) order.installationDate = options.installationDate;
  if (action === "cancel") {
    order.cancelledAt = new Date();
    order.cancellationReason = String(options.cancellationReason || "").trim();
    if (
      String(order.paymentProvider || "").toLowerCase() === "paymongo" &&
      String(order.paymentStatus || "").toLowerCase() === "paid"
    ) {
      order.refundReview = {
        required: true,
        status: "needs_review",
        reason:
          order.cancellationReason ||
          `Paid PayMongo order ${order.orderCode} was cancelled and needs manual refund review.`,
        markedAt: new Date(),
      };
    }
  }

  await order.save();
  await updateSerialUnitsForOrder(order, order.workflowStatus);
  if (action === "cancel") {
    await releaseOrderInventoryOnce(order, order.cancellationReason);
    await order.save();
    await Task.updateMany(
      {
        $or: [
          { "payload.orderId": String(order._id || order.id || "") },
          { "payload.orderCode": order.orderCode },
        ],
      },
      {
        $set: {
          status: "on-hold",
          "payload.status": "on-hold",
          "payload.cancelledByOrder": true,
          "payload.updatedAt": new Date().toISOString(),
        },
      },
    );
  }
  if (action === "complete") {
    order.stockReservationStatus = "consumed";
    order.stockReleasedAt = null;
    await order.save();
  }
  if (action === "approve" || action === "dispatch") {
    await createTaskForOrder(order, {
      ...options,
      assignedTechnicianId: assignment.assignedTechnicianId,
      assignedTechnicianName: assignment.assignedTechnicianName,
    });
  }

  if (options.actorUserId && mongoose.Types.ObjectId.isValid(String(options.actorUserId))) {
    await AuditLog.create({
      action: "order_lifecycle_updated",
      user: options.actorUserId,
      branch: order.stockSourceBranch || order.customerBranch || "",
      entityType: "order",
      entityId: order._id,
      changeDetails: {
        before: { workflowStatus: options.previousWorkflowStatus, assignedTechnicianId: options.previousTechnicianId || "" },
        after: { workflowStatus: order.workflowStatus, deliveryStatus: order.deliveryStatus, assignedTechnicianId: order.assignedTechnicianId || "", dispatchedAt: order.dispatchedAt || null },
      },
      description: `${action} order ${order.orderCode}; technician task synchronized.`,
    });
  }

  await createOrderNotification({
    customerId: order.customer,
    title: config.title,
    message:
      action === "approve" && order.assignedTechnician
        ? `${config.message(order.orderCode)} Technician assigned: ${order.assignedTechnician}.`
        : action === "cancel" && order.refundReview?.required
          ? `${config.message(order.orderCode)} Your paid order is marked for refund review.`
          : config.message(order.orderCode),
  });
};

const approveOrder = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { orderId } = req.params;
  const {
    assignedTechnician,
    assignedTechnicianId = "",
    assignedTechnicianName = "",
    estimatedArrival,
    installationDate,
    timeSlot = "",
  } =
    req.body || {};

  const order = await getOrderForAdminAction(req, orderId);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  try {
    await applyOrderLifecycleAction(order, "approve", {
      assignedTechnician,
      assignedTechnicianId,
      assignedTechnicianName,
      estimatedArrival,
      installationDate,
      timeSlot,
      actorUserId: req.authUser._id,
      previousWorkflowStatus: order.workflowStatus,
      previousTechnicianId: order.assignedTechnicianId,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ message: error.message });
    }
    throw error;
  }

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({ order: hydratedOrder });
};

const listMyOrders = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const orders = await Order.find({ customer: req.authUser._id }).sort({
    createdAt: -1,
  });
  console.log("List my orders", {
    userId: String(req.authUser._id),
    count: Number(orders.length || 0),
  });
  const hydratedOrders = await hydrateOrdersWithInventoryQrCodes(orders);
  return res.json({ orders: hydratedOrders });
};

const getMyOrderById = async (req, res) => {
  const { orderId } = req.params;
  const conditions = [{ orderCode: orderId }];
  if (mongoose.Types.ObjectId.isValid(orderId)) conditions.unshift({ _id: orderId });
  const order = await Order.findOne({
    $or: conditions,
    customer: req.authUser._id,
  });

  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({ order: hydratedOrder });
};

const getOrderByIdForAdmin = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const order = await getOrderForAdminAction(req, req.params.orderId);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({ order: hydratedOrder });
};

const getMyOrderSummary = async (req, res) => {
  const orders = await Order.find({ customer: req.authUser._id });
  const summary = {
    toPay: 0,
    toDeliver: 0,
    toInstall: 0,
    complete: 0,
    cancelled: 0,
  };

  orders.forEach((order) => {
    if (order.workflowStatus === "to_pay") summary.toPay += 1;
    if (order.workflowStatus === "to_deliver") summary.toDeliver += 1;
    if (order.workflowStatus === "to_install") summary.toInstall += 1;
    if (order.workflowStatus === "complete") summary.complete += 1;
    if (order.workflowStatus === "cancelled") summary.cancelled += 1;
  });

  return res.json({ summary });
};

const listOrdersForAdmin = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const query = {};
  if (req.authUser.role !== "superadmin" && req.activeBranch) {
    query.$or = [
      { customerBranch: req.activeBranch },
      { stockSourceBranch: req.activeBranch },
    ];
  }

  const orders = await Order.find(query).sort({ createdAt: -1 });
  const hydratedOrders = await hydrateOrdersWithInventoryQrCodes(orders);
  return res.json({
    orders: hydratedOrders,
    paymentGateway: getPaymongoRuntimeStatus(),
  });
};

const processOrder = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const { orderId } = req.params;
  const {
    action = "approve",
    assignedTechnicianId = "",
    assignedTechnicianName = "",
    assignedTechnician = "",
    estimatedArrival = "",
    installationDate = "",
    timeSlot = "",
    cancellationReason = "",
  } = req.body || {};
  const normalizedAction = String(action || "").trim().toLowerCase();
  const order = await getOrderForAdminAction(req, orderId);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  try {
    await applyOrderLifecycleAction(order, normalizedAction, {
      assignedTechnicianId,
      assignedTechnicianName,
      assignedTechnician,
      estimatedArrival,
      installationDate,
      timeSlot,
      cancellationReason,
      actorUserId: req.authUser._id,
      previousWorkflowStatus: order.workflowStatus,
      previousTechnicianId: order.assignedTechnicianId,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ message: error.message });
    }
    throw error;
  }

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({ order: hydratedOrder });
};

const recoverOrder = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const order = await getOrderForAdminAction(req, req.params.orderId);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const action = String(req.body?.action || "").trim().toLowerCase();
  const form = req.body || {};

  if (action === "recreate_task") {
    const technician = await resolveTechnicianAssignment({
      assignedTechnicianId: form.assignedTechnicianId || "",
      assignedTechnicianName: form.assignedTechnicianName || order.assignedTechnician || "",
    });
    const task = await createTaskForOrder(order, {
      assignedTechnicianId: technician.assignedTechnicianId,
      assignedTechnicianName: technician.assignedTechnicianName,
      estimatedArrival: form.estimatedArrival || order.estimatedArrival || "",
      installationDate: form.installationDate || order.installationDate || "",
      timeSlot: form.timeSlot || "",
      forceRefreshTask: true,
    });
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({
      message: `Technician task synced for ${order.orderCode}.`,
      order: hydratedOrder,
      task,
    });
  }

  if (action === "assign_technician") {
    const technician = await resolveTechnicianAssignment({
      assignedTechnicianId: form.assignedTechnicianId || "",
      assignedTechnicianName: form.assignedTechnicianName || "",
    });
    if (!technician.assignedTechnicianId) {
      return res.status(400).json({ message: "Select a technician before assigning this work order." });
    }
    if (["complete", "cancelled"].includes(order.workflowStatus)) {
      return res.status(409).json({ message: `Cannot change the technician for a ${workflowLabel(order.workflowStatus)} order.` });
    }

    order.assignedTechnician = technician.assignedTechnicianName;
    if (form.estimatedArrival) order.estimatedArrival = form.estimatedArrival;
    if (form.installationDate) order.installationDate = form.installationDate;
    await order.save();

    const task = await createTaskForOrder(order, {
      assignedTechnicianId: technician.assignedTechnicianId,
      assignedTechnicianName: technician.assignedTechnicianName,
      estimatedArrival: form.estimatedArrival || order.estimatedArrival || "",
      installationDate: form.installationDate || order.installationDate || "",
      timeSlot: form.timeSlot || "",
      forceRefreshTask: true,
    });
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({
      message: `${technician.assignedTechnicianName} is assigned to ${order.orderCode}. The work order is now in their My Work list.`,
      order: hydratedOrder,
      task,
    });
  }

  if (action === "sync_installed_units") {
    const linkedTask = await findLinkedTaskForOrder(order);
    if (!linkedTask) {
      return res.status(404).json({
        message: `Order ${order.orderCode} has no linked technician task to sync from.`,
      });
    }
    if (String(linkedTask.status || "").toLowerCase() !== "completed") {
      return res.status(409).json({
        message: `Complete technician task ${linkedTask.taskCode || linkedTask.id} before syncing installed customer units.`,
      });
    }

    const installedUnits = await syncInstalledUnitsFromTask(linkedTask);
    await updateSerialUnitsForOrder(order, "complete");
    order.workflowStatus = "complete";
    order.status = "paid";
    order.stockReservationStatus = "consumed";
    order.stockReleasedAt = null;
    await order.save();
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({
      message: `Synced ${installedUnits.length} installed customer unit(s) for ${order.orderCode}.`,
      order: hydratedOrder,
      installedUnits,
    });
  }

  return res.status(400).json({
    message: "Recovery action must be assign_technician, recreate_task, or sync_installed_units.",
  });
};

const updateRefundReview = async (req, res) => {
  if (!["admin", "superadmin"].includes(req.authUser.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const order = await getOrderForAdminAction(req, req.params.orderId);
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const existingReview = order.refundReview?.toObject?.() || order.refundReview || {};
  const isPaidPaymongoCancellation =
    String(order.paymentProvider || "").toLowerCase() === "paymongo" &&
    String(order.paymentStatus || "").toLowerCase() === "paid" &&
    String(order.workflowStatus || "").toLowerCase() === "cancelled";
  if (!existingReview.required && !isPaidPaymongoCancellation) {
    return res.status(409).json({ message: "This order does not require PayMongo refund review." });
  }

  const nextStatus = String(req.body?.status || req.body?.action || "").trim().toLowerCase();
  if (!["reviewed", "completed"].includes(nextStatus)) {
    return res.status(400).json({ message: "Refund review status must be reviewed or completed." });
  }

  const reviewerName = getUserDisplayName(req.authUser) || req.authUser.email || "Admin";
  const now = new Date();
  const note = String(req.body?.note || "").trim();
  const before = {
    required: Boolean(existingReview.required),
    status: existingReview.status || "none",
    note: existingReview.note || "",
  };

  order.refundReview = {
    ...existingReview,
    required: true,
    status: nextStatus,
    reason:
      existingReview.reason ||
      order.cancellationReason ||
      `Paid PayMongo order ${order.orderCode} was cancelled and needs manual refund review.`,
    markedAt: existingReview.markedAt || now,
    note: note || existingReview.note || "",
    reviewedBy: existingReview.reviewedBy || req.authUser._id,
    reviewedByName: existingReview.reviewedByName || reviewerName,
    reviewedAt: existingReview.reviewedAt || now,
    completedBy: nextStatus === "completed" ? req.authUser._id : existingReview.completedBy || null,
    completedByName: nextStatus === "completed" ? reviewerName : existingReview.completedByName || "",
    completedAt: nextStatus === "completed" ? now : existingReview.completedAt || null,
  };
  if (nextStatus === "completed" && order.cancellationRequest?.requested) {
    order.cancellationRequest = {
      ...(order.cancellationRequest?.toObject?.() || order.cancellationRequest || {}),
      status: "approved",
      resolvedAt: now,
      resolvedBy: req.authUser._id,
      resolvedByName: reviewerName,
    };
  }

  await order.save();

  try {
    await AuditLog.create({
      action: "order_refund_review_updated",
      user: req.authUser._id,
      branch: req.activeBranch || order.stockSourceBranch || order.customerBranch || "",
      entityType: "order",
      entityId: order._id,
      changeDetails: {
        before,
        after: {
          required: true,
          status: nextStatus,
          note: order.refundReview.note || "",
        },
      },
      description: `Refund review for ${order.orderCode} marked ${nextStatus}.`,
      ipAddress: req.ip || "",
    });
  } catch (error) {
    console.warn("Failed to write refund review audit log:", error);
  }

  await createOrderNotification({
    customerId: order.customer,
    title: nextStatus === "completed" ? "Refund review completed" : "Refund review updated",
    message:
      nextStatus === "completed"
        ? `Refund review for order ${order.orderCode} has been completed.`
        : `Refund review for order ${order.orderCode} has been reviewed by admin.`,
  });

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({ order: hydratedOrder });
};

const requestCustomerCancellation = async (req, res) => {
  const { orderId } = req.params;
  const conditions = [{ orderCode: orderId }];
  if (mongoose.Types.ObjectId.isValid(orderId)) conditions.unshift({ _id: orderId });
  const order = await Order.findOne({
    $or: conditions,
    customer: req.authUser._id,
  });
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  if (order.workflowStatus === "cancelled") {
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({ order: hydratedOrder, message: "Order is already cancelled." });
  }

  if (!["to_pay", "to_deliver"].includes(order.workflowStatus)) {
    return res.status(409).json({
      message: "This order can no longer be cancelled from the customer app because it is already dispatched or completed.",
    });
  }

  const existingRequest = order.cancellationRequest?.toObject?.() || order.cancellationRequest || {};
  if (existingRequest.requested && existingRequest.status === "requested") {
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({ order: hydratedOrder, message: "Cancellation request is already pending." });
  }

  const reason = String(req.body?.reason || "").trim() || "Customer requested cancellation.";
  const requesterName = getUserDisplayName(req.authUser) || req.authUser.email || "Customer";
  const isPaidPaymongo =
    String(order.paymentProvider || "").toLowerCase() === "paymongo" &&
    String(order.paymentStatus || "").toLowerCase() === "paid";
  const now = new Date();

  order.cancellationRequest = {
    requested: true,
    status: isPaidPaymongo ? "requested" : "approved",
    reason,
    requestedAt: existingRequest.requestedAt || now,
    requestedBy: req.authUser._id,
    requestedByName: requesterName,
    resolvedAt: isPaidPaymongo ? null : now,
    resolvedBy: isPaidPaymongo ? null : req.authUser._id,
    resolvedByName: isPaidPaymongo ? "" : requesterName,
  };

  try {
    await applyOrderLifecycleAction(order, "cancel", {
      cancellationReason: reason,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ message: error.message });
    }
    throw error;
  }

  try {
    await AuditLog.create({
      action: "order_cancellation_requested",
      user: req.authUser._id,
      branch: order.stockSourceBranch || order.customerBranch || "",
      entityType: "order",
      entityId: order._id,
      changeDetails: {
        before: {
          workflowStatus: "to_pay/to_deliver",
          cancellationRequest: existingRequest.status || "none",
        },
        after: {
          workflowStatus: order.workflowStatus,
          cancellationRequest: order.cancellationRequest?.status || "requested",
          refundReview: order.refundReview?.status || "none",
        },
      },
      description: `${requesterName} requested cancellation for ${order.orderCode}.`,
      ipAddress: req.ip || "",
    });
  } catch (error) {
    console.warn("Failed to write cancellation request audit log:", error);
  }

  await createStaffOrderNotification({
    order,
    title: isPaidPaymongo ? "Refund review requested" : "Order cancelled by customer",
    message: isPaidPaymongo
      ? `Customer requested cancellation/refund for paid PayMongo order ${order.orderCode}.`
      : `Customer cancelled order ${order.orderCode}.`,
  });

  const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
  return res.json({
    order: hydratedOrder,
    message: isPaidPaymongo
      ? "Cancellation was submitted. Your paid order is now waiting for refund review."
      : "Order cancelled successfully.",
  });
};

const handlePaymongoWebhook = async (req, res) => {
  try {
    const event = extractPaymongoEvent(req.body || {});
    const order = await findOrderForPaymongoEvent(event);
    if (!order) {
      console.warn("PayMongo webhook did not match an order", {
        eventType: event.eventType,
        resourceId: event.resourceId,
        orderCode: event.orderCode,
      });
      return res.json({ received: true, matched: false });
    }

    await applyPaymongoEventToOrder(order, event, req.body || {});
    return res.json({ received: true, matched: true, orderCode: order.orderCode });
  } catch (error) {
    console.error("Failed to process PayMongo webhook:", error);
    return res.status(500).json({ message: "Unable to process PayMongo webhook." });
  }
};

const escapeHtml = (value = "") =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const handlePaymongoReturn = async (req, res) => {
  const orderId = String(req.params.orderId || "").trim();
  const paymentState =
    String(req.query.payment || "").toLowerCase() === "cancelled"
      ? "cancelled"
      : "success";
  const target = normalizePaymentReturnTarget(req.query.target);
  const webUrl = `${envFrontendUrl()}/order-confirmation/${encodeURIComponent(orderId)}?payment=${encodeURIComponent(paymentState)}`;

  if (target !== "mobile") {
    return res.redirect(302, webUrl);
  }

  const appUrl = mobileDeepLinkForOrder(orderId, paymentState);
  return res
    .status(200)
    .set("Content-Type", "text/html; charset=utf-8")
    .send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Returning to Coldair</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
    main { width: min(420px, calc(100% - 32px)); background: #fff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 28px; box-shadow: 0 18px 45px rgba(15,23,42,.12); text-align: center; }
    a { display: inline-block; margin-top: 18px; padding: 12px 18px; border-radius: 12px; background: #2563eb; color: #fff; text-decoration: none; font-weight: 800; }
    p { color: #64748b; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Returning to Coldair</h1>
    <p>Your payment page is sending you back to the app. If it does not open automatically, tap the button below.</p>
    <a href="${escapeHtml(appUrl)}">Open Coldair App</a>
  </main>
  <script>
    var appUrl = ${JSON.stringify(appUrl)};
    var webUrl = ${JSON.stringify(webUrl)};
    setTimeout(function () { window.location.href = appUrl; }, 250);
    setTimeout(function () { window.location.href = webUrl; }, 2400);
  </script>
</body>
</html>`);
};

const retryPaymongoCheckout = async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [{ _id: req.params.orderId }, { orderCode: req.params.orderId }],
      customer: req.authUser._id,
    });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    if (!isOnlinePaymentMethod(order.paymentMethod)) {
      return res.status(400).json({ message: "This order does not use PayMongo checkout." });
    }
    if (order.paymentStatus === "paid" || order.status === "paid") {
      return res.status(409).json({ message: "This order is already paid." });
    }

    await reReserveReleasedOrderInventory(order);

    const checkout = await attachPaymongoCheckout(order, {
      req,
      returnTarget: req.body?.paymentReturnTarget || req.body?.returnTarget || req.body?.clientType || req.body?.platform,
    });
    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({
      order: {
        ...hydratedOrder,
        paymentUrl: checkout.checkoutUrl,
      },
      payment: {
        provider: "paymongo",
        checkoutSessionId: checkout.id,
        checkoutUrl: checkout.checkoutUrl,
        status: checkout.status,
      },
    });
  } catch (error) {
    console.error("Failed to retry PayMongo checkout:", error);
    if (error instanceof HttpError || error instanceof PaymongoError) {
      return res.status(error.status || 500).json({ message: error.message });
    }
    return res.status(500).json({ message: "Unable to start PayMongo checkout." });
  }
};

const verifyPaymongoCheckout = async (req, res) => {
  try {
    const order = await Order.findOne({
      $or: [{ _id: req.params.orderId }, { orderCode: req.params.orderId }],
    });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    const currentUserId = String(req.authUser?._id || "");
    const isOwner = String(order.customer || "") === currentUserId;
    if (!isOwner && !["admin", "superadmin"].includes(req.authUser.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (String(order.paymentProvider || "").toLowerCase() !== "paymongo") {
      return res.status(400).json({ message: "This order does not use PayMongo checkout." });
    }
    const checkoutSessionId = String(order.paymongo?.checkoutSessionId || "").trim();
    if (!checkoutSessionId) {
      return res.status(400).json({ message: "PayMongo checkout session is not linked to this order." });
    }

    const session = await getCheckoutSession(checkoutSessionId);
    const event = buildEventFromCheckoutSession(session);
    if (checkoutSessionLooksPaid(session) || checkoutSessionLooksClosed(session)) {
      await applyPaymongoEventToOrder(order, event, session);
    } else {
      order.paymongo = {
        ...(order.paymongo?.toObject?.() || order.paymongo || {}),
        status: session?.data?.attributes?.status || order.paymongo?.status || "",
        raw: session,
      };
      await order.save();
    }

    const [hydratedOrder] = await hydrateOrdersWithInventoryQrCodes([order]);
    return res.json({
      order: hydratedOrder,
      paymentStatus: order.paymentStatus,
      paymongoStatus: order.paymongo?.status || "",
      matched: true,
    });
  } catch (error) {
    console.error("Failed to verify PayMongo checkout:", error);
    if (error instanceof PaymongoError) {
      return res.status(error.status || 500).json({ message: error.message });
    }
    return res.status(500).json({ message: "Unable to verify PayMongo checkout." });
  }
};

module.exports = {
  createOrder,
  listMyOrders,
  getMyOrderById,
  getMyOrderSummary,
  approveOrder,
  listOrdersForAdmin,
  getOrderByIdForAdmin,
  processOrder,
  recoverOrder,
  updateRefundReview,
  requestCustomerCancellation,
  handlePaymongoWebhook,
  handlePaymongoReturn,
  retryPaymongoCheckout,
  verifyPaymongoCheckout,
};
