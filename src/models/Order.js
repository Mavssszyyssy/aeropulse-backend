const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    orderCode: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    customerName: { type: String, required: true },
    items: [
      {
        productId: { type: String, default: "" },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        specs: { type: String, default: "" },
        sourceBranch: { type: String, default: "" },
        serialNumbers: [{ type: String, trim: true }],
        serialUnits: [
          {
            serialNumber: { type: String, default: "", trim: true },
            qrCode: { type: String, default: "", trim: true },
          },
        ],
      },
    ],
    address: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      street: { type: String, default: "" },
      barangay: { type: String, default: "" },
      city: { type: String, default: "" },
      province: { type: String, default: "" },
      region: { type: String, default: "" },
      postalCode: { type: String, default: "" },
    },
    paymentMethod: { type: String, default: "cod" },
    paymentProvider: { type: String, default: "" },
    idempotencyKey: { type: String, trim: true, index: true, sparse: true },
    stockReservationStatus: {
      type: String,
      enum: ["reserved", "released", "consumed"],
      default: "reserved",
      index: true,
    },
    stockReleasedAt: { type: Date, default: null },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "cancelled", "expired", "not_required"],
      default: "pending",
      index: true,
    },
    paymongo: {
      checkoutSessionId: { type: String, default: "", index: true },
      checkoutUrl: { type: String, default: "" },
      paymentIntentId: { type: String, default: "", index: true },
      paymentId: { type: String, default: "", index: true },
      referenceNumber: { type: String, default: "" },
      status: { type: String, default: "" },
      paidAt: { type: Date, default: null },
      lastEventType: { type: String, default: "" },
      lastEventKey: { type: String, default: "" },
      raw: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    proofOfPayment: {
      imageUrl: { type: String, default: "" },
      status: {
        type: String,
        enum: ["none", "pending", "confirmed", "rejected"],
        default: "none",
      },
    },
    trackingNumber: { type: String, default: "" },
    estimatedDelivery: { type: String, default: "" },
    estimatedArrival: { type: String, default: "" },
    installationDate: { type: String, default: "" },
    assignedTechnician: { type: String, default: "" },
    assignedTechnicianId: { type: String, default: "", index: true },
    deliveryStatus: {
      type: String,
      enum: ["pending", "preparing", "dispatched", "installing", "completed", "cancelled"],
      default: "pending",
      index: true,
    },
    dispatchedAt: { type: Date, default: null },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // This is the single customer-facing fulfillment record.  It is updated
    // by order actions and technician task actions so receipt/tracking views
    // never need to guess a different status from cached client state.
    fulfillmentTimeline: [
      {
        stage: { type: String, required: true },
        label: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        detail: { type: String, default: "" },
      },
    ],
    customerBranch: { type: String, default: "" },
    stockSourceBranch: { type: String, default: "" },
    receipt: {
      receiptNumber: { type: String, default: "" },
      issuedAt: { type: String, default: "" },
      paymentMethod: { type: String, default: "" },
      paymentProvider: { type: String, default: "" },
      paymentReference: { type: String, default: "" },
      paymentStatus: { type: String, default: "" },
      amountPaid: { type: Number, default: 0 },
      subtotalAmount: { type: Number, default: 0 },
      vatAmount: { type: Number, default: 0 },
      shippingFee: { type: Number, default: 0 },
      discountAmount: { type: Number, default: 0 },
      itemsSummary: { type: String, default: "" },
    },
    subtotalAmount: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    shippingFee: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    workflowStatus: {
      type: String,
      enum: ["to_pay", "to_deliver", "to_install", "complete", "cancelled"],
      default: "to_pay",
    },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled"],
      default: "pending",
    },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: "", trim: true },
    cancellationRequest: {
      requested: { type: Boolean, default: false },
      status: {
        type: String,
        enum: ["none", "requested", "approved", "declined"],
        default: "none",
      },
      reason: { type: String, default: "", trim: true },
      requestedAt: { type: Date, default: null },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      requestedByName: { type: String, default: "" },
      resolvedAt: { type: Date, default: null },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      resolvedByName: { type: String, default: "" },
    },
    refundReview: {
      required: { type: Boolean, default: false },
      status: {
        type: String,
        enum: ["none", "needs_review", "reviewed", "completed"],
        default: "none",
      },
      reason: { type: String, default: "" },
      markedAt: { type: Date, default: null },
      note: { type: String, default: "", trim: true },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      reviewedByName: { type: String, default: "" },
      reviewedAt: { type: Date, default: null },
      completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      completedByName: { type: String, default: "" },
      completedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

orderSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

orderSchema.index(
  { customer: 1, idempotencyKey: 1 },
  { unique: true, sparse: true, name: "idx_customer_order_idempotency" },
);

module.exports = mongoose.model("Order", orderSchema);
