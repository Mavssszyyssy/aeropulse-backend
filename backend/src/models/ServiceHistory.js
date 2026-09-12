const mongoose = require("mongoose");

const serviceHistorySchema = new mongoose.Schema(
  {
    sourceTaskId: { type: String, trim: true },
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

    // The technician's original findings/actions above remain authoritative.
    // This separate record stores only the AI interpretation and its follow-up.
    aiInterpretation: {
      provider: { type: String, enum: ["", "openai", "system-fallback"], default: "" },
      status: { type: String, enum: ["", "completed", "unavailable"], default: "" },
      whatHappened: { type: String, default: "", trim: true },
      problemsFound: { type: String, default: "", trim: true },
      severity: { type: String, enum: ["", "routine", "monitor", "soon", "urgent", "not_assessed"], default: "" },
      repairOrReplacement: { type: String, enum: ["", "not_indicated", "inspection_needed", "repair_may_be_needed", "replacement_may_be_needed", "not_assessed"], default: "" },
      recommendedAction: { type: String, enum: ["", "routine_cleaning", "inspection", "repair_assessment", "existing_schedule"], default: "" },
      recommendedActions: [{ type: String, trim: true }],
      recommendedService: { type: String, enum: ["", "regular_cleaning", "deep_cleaning", "inspection", "repair"], default: "" },
      recommendedFollowUpDays: { type: Number, default: null, min: 1, max: 730 },
      recommendedFollowUpDate: { type: Date, default: null },
      evidenceFactIds: [{ type: String, trim: true }],
      customerSummary: { type: String, default: "", trim: true },
      model: { type: String, default: "", trim: true },
      requestId: { type: String, default: "", trim: true },
      generatedAt: { type: Date, default: null },
      warning: { type: String, default: "", trim: true },
    },
  },
  { timestamps: true },
);

serviceHistorySchema.index({ unit: 1, serviceDate: -1 });
serviceHistorySchema.index({ unit: 1, sourceTaskId: 1 }, { unique: true, partialFilterExpression: { sourceTaskId: { $type: "string" } } });

serviceHistorySchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ServiceHistory", serviceHistorySchema);
