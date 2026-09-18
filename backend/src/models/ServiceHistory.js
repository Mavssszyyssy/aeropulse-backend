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
    hoursSpent: { type: Number, default: null, min: 0, max: 1000 },
    laborCost: { type: Number, default: null, min: 0, max: 1000000 },
    partsCost: { type: Number, default: null, min: 0, max: 1000000 },
    additionalCost: { type: Number, default: null, min: 0, max: 1000000 },
    totalServiceCost: { type: Number, default: null, min: 0, max: 3000000 },

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

    // Snapshot the customer's original request context beside the completed
    // visit. Technician findings remain authoritative and separate.
    customerInputs: {
      reportedIssue: { type: String, default: "", trim: true },
      notes: { type: String, default: "", trim: true },
      other: { type: String, default: "", trim: true },
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
      analysisVersion: { type: Number, default: 0, min: 0 },
      provider: { type: String, enum: ["", "openai", "system-fallback"], default: "" },
      status: { type: String, enum: ["", "completed", "unavailable"], default: "" },
      whatHappened: { type: String, default: "", trim: true },
      problemsFound: { type: String, default: "", trim: true },
      overallCondition: { type: String, default: "", trim: true },
      componentConcern: { type: String, default: "", trim: true },
      severity: { type: String, enum: ["", "routine", "monitor", "soon", "urgent", "critical", "not_assessed"], default: "" },
      riskType: { type: String, enum: ["", "no_problem_indicated", "component_deterioration", "performance_decline", "leak_or_drainage", "electrical_or_safety", "other_recorded_risk", "not_assessed"], default: "" },
      predictedRisk: { type: String, default: "", trim: true },
      affectedComponent: { type: String, default: "", trim: true },
      evidenceConfidence: { type: String, enum: ["", "low", "medium", "high", "not_assessed"], default: "" },
      recommendationMode: { type: String, enum: ["", "condition_based", "routine", "fallback"], default: "" },
      repairOrReplacement: { type: String, enum: ["", "not_indicated", "inspection_needed", "repair_may_be_needed", "replacement_may_be_needed", "not_assessed"], default: "" },
      recommendedPart: { type: String, default: "", trim: true },
      partRecommendationStatus: { type: String, enum: ["", "not_indicated", "inspection_required", "recorded_part"], default: "" },
      inventoryMessage: { type: String, default: "", trim: true },
      inventoryMatches: [{
        name: { type: String, default: "", trim: true },
        sku: { type: String, default: "", trim: true },
        companyStock: { type: Number, default: null },
        branchStock: { type: Number, default: null },
      }],
      recommendedAction: { type: String, enum: ["", "routine_cleaning", "inspection", "repair_assessment", "existing_schedule"], default: "" },
      recommendedActions: [{ type: String, trim: true }],
      recommendedService: { type: String, enum: ["", "regular_cleaning", "deep_cleaning", "inspection", "repair"], default: "" },
      recommendedFollowUpDays: { type: Number, default: null, min: 1, max: 365 },
      recommendedFollowUpDate: { type: Date, default: null },
      evidenceFactIds: [{ type: String, trim: true }],
      aiAssessment: { type: String, default: "", trim: true },
      whyThisDate: { type: String, default: "", trim: true },
      customerSummary: { type: String, default: "", trim: true },
      model: { type: String, default: "", trim: true },
      requestId: { type: String, default: "", trim: true },
      generatedAt: { type: Date, default: null },
      warning: { type: String, default: "", trim: true },
      analysisAttempts: { type: Number, default: 0, min: 0, max: 10 },
      lastAnalysisAttemptAt: { type: Date, default: null },
      nextAnalysisAttemptAt: { type: Date, default: null, index: true },
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
