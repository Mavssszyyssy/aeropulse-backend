const mongoose = require("mongoose");

const serviceHistorySchema = new mongoose.Schema(
  {
    unit: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      required: true,
      index: true,
    },

    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    serviceDate: {
      type: Date,
      required: true,
      index: true,
    },

    visitType: {
      type: String,
      enum: ["installation", "scheduled_service", "repair", "inspection"],
      default: "scheduled_service",
    },

    serviceType: {
      type: String,
      enum: ["regular_cleaning", "deep_cleaning", "repair", "inspection", "installation"],
      default: "regular_cleaning",
      index: true,
    },
    findings: { type: String, default: "", trim: true },
    actionTaken: { type: String, default: "", trim: true },
    partsUsed: [{ type: String, trim: true }],

    conditionRating: {
      type: String,
      enum: ["excellent", "good", "fair", "poor"],
      default: "good",
    },

    technicianInputs: {
      visualWearRating: { type: Number, min: 1, max: 10 },
      estimatedHoursUsed: { type: Number, min: 0 },
      refrigerantLevel: { type: Number, min: 0, max: 100 },
      usageHoursPerDay: { type: Number, default: 8, min: 0, max: 24 },
      filterCondition: {
        type: String,
        enum: ["clean", "normal", "dusty", "clogged"],
        default: "normal",
      },
      coilCondition: {
        type: String,
        enum: ["clean", "normal", "dusty", "iced"],
        default: "normal",
      },
      drainageCondition: {
        type: String,
        enum: ["clear", "slow", "blocked"],
        default: "clear",
      },
      voltageStability: {
        type: String,
        enum: ["stable", "fluctuating", "unstable"],
        default: "stable",
      },
      placementArea: { type: String, default: "", trim: true },
      notes: { type: String, default: "", trim: true },
    },

    serviceActions: [{ type: String, trim: true }],

    ampSnapshot: {
      bestServicedBy: { type: Date, default: null },
      recommendedService: { type: String, default: "", trim: true },
      recommendationBasis: { type: String, default: "", trim: true },
      nextIdealServiceDate: { type: Date, default: null },
      nextIdealServicePeriod: { type: String, default: "", trim: true },
      calculatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

serviceHistorySchema.index({ unit: 1, serviceDate: -1 });

serviceHistorySchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ServiceHistory", serviceHistorySchema);
