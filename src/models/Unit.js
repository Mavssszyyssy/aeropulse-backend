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
    productId: { type: String, default: "", trim: true },
    modelName: { type: String, default: "", trim: true },
    brand: { type: String, default: "", trim: true },
    capacityHp: { type: Number, default: 0, min: 0 },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    customerName: { type: String, default: "", trim: true },

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
