const mongoose = require("mongoose");

const coordinatesSchema = new mongoose.Schema(
  {
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
  },
  { _id: false },
);

const unitSchema = new mongoose.Schema(
  {
    serialNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    qrCode: { type: String, default: "", trim: true },
    qrUnitId: { type: String, default: "", trim: true, index: true },
    productId: { type: String, default: "", trim: true },
    modelName: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    capacityHp: { type: Number, default: 0, min: 0 },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    customerName: { type: String, default: "", trim: true },
    // The operating branch responsible for this installed unit. This is kept
    // with the unit so AMP reports remain traceable after a task is archived.
    serviceBranch: { type: String, default: "", trim: true, index: true },

    installation: {
      installedAt: { type: Date, default: null },
      installedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      addressLine: { type: String, default: "", trim: true },
      city: { type: String, default: "", trim: true },
      province: { type: String, default: "", trim: true },
      zipCode: { type: String, required: true, trim: true, index: true },
      coordinates: { type: coordinatesSchema, default: () => ({}) },
    },

    amp: {
      // Customers should not see this raw score. It exists for backend prediction only.
      currentHealthScore: { type: Number, default: 100, min: 0, max: 100 },

      // The score boundary where AMP says the unit should be serviced.
      serviceThreshold: { type: Number, default: 60, min: 1, max: 100 },

      // Base health points lost per calendar day under normal environmental conditions.
      dailyBaseDecay: { type: Number, default: 0.22, min: 0 },

      // A multiplier knob for old units, harsh installation sites, or fragile models.
      historicalCurveFactor: { type: Number, default: 1, min: 0.1 },

      // Last customer-facing recommendation as a period, not a raw score.
      nextIdealServicePeriod: { type: String, default: "", trim: true },

      // Exact internal projected crossing date for audit and dispatch planning.
      nextIdealServiceDate: { type: Date, default: null },

      lastCalculatedAt: { type: Date, default: null },
    },

    warranty: {
      warrantyType: { type: String, default: "Standard manufacturer warranty", trim: true },
      startDate: { type: Date, default: null },
      expirationDate: { type: Date, default: null, index: true },
      durationMonths: { type: Number, default: 60, min: 1 },
      coveredComponents: [{ type: String, trim: true }],
      coverageLimitations: [{ type: String, trim: true }],
      status: {
        type: String,
        enum: ["pending_activation", "active", "expired", "under_review", "approved", "rejected", "void"],
        default: "pending_activation",
        index: true,
      },
      claims: [
        {
          claimId: { type: String, required: true },
          issue: { type: String, default: "", trim: true },
          status: { type: String, enum: ["submitted", "under_review", "approved", "rejected", "service_completed"], default: "submitted" },
          requestedAt: { type: Date, default: Date.now },
          reviewedAt: { type: Date, default: null },
          resolvedAt: { type: Date, default: null },
          reviewerName: { type: String, default: "", trim: true },
          decisionNote: { type: String, default: "", trim: true },
          serviceRequestId: { type: String, default: "" },
          serviceHistoryId: { type: String, default: "" },
        },
      ],
      serviceRecords: [
        {
          serviceDate: { type: Date, default: Date.now },
          visitType: { type: String, default: "service" },
          summary: { type: String, default: "", trim: true },
          serviceHistoryId: { type: String, default: "" },
          claimId: { type: String, default: "" },
        },
      ],
      timeline: [
        {
          event: { type: String, required: true },
          detail: { type: String, default: "", trim: true },
          timestamp: { type: Date, default: Date.now },
        },
      ],
    },

    status: {
      type: String,
      enum: ["active", "service_due", "on_hold", "retired"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

unitSchema.index({ "installation.zipCode": 1, status: 1 });
unitSchema.index({ customer: 1, status: 1 });

unitSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Unit", unitSchema);
