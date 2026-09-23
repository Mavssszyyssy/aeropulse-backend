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
    category: { type: String, default: "", trim: true, index: true },
    roomSizeSqm: { type: Number, default: null, min: 1, max: 10000 },

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
      // Server-only validated estimate; invalidated by a change in its evidence fingerprint.
      aiPrediction: { type: mongoose.Schema.Types.Mixed, default: null },
      predictionSource: { type: String, enum: ["system", "openai"], default: "system" },
      bestServicedBy: { type: Date, default: null, index: true },
      recommendedService: {
        type: String,
        enum: ["", "regular_cleaning", "deep_cleaning", "inspection", "repair"],
        default: "regular_cleaning",
      },
      recommendationBasis: { type: String, default: "", trim: true },
      aiAssessment: { type: String, default: "", trim: true },
      whyThisDate: { type: String, default: "", trim: true },
      basisLevel: {
        type: String,
        enum: ["same_unit", "same_model", "same_brand_type", "same_brand", "similar_category", "system_default"],
        default: "system_default",
      },
      intervalDays: { type: Number, default: 180, min: 30, max: 730 },
      baseIntervalDays: { type: Number, default: 180, min: 30, max: 730 },
      comparableSampleSize: { type: Number, default: 0, min: 0 },
      patternAnalysis: { type: mongoose.Schema.Types.Mixed, default: null },
      maintenanceSignals: { type: mongoose.Schema.Types.Mixed, default: null },
      lastServiceDate: { type: Date, default: null },
      lastCleaningDate: { type: Date, default: null },
      dataQuality: {
        excludedRecordCount: { type: Number, default: 0 },
        message: { type: String, default: "" },
        anchorType: { type: String, default: "" },
      },
      capacityAssessment: {
        status: {
          type: String,
          enum: ["suitable", "insufficient", "higher_than_necessary", "room_size_required", "capacity_required"],
          default: "room_size_required",
        },
        summary: { type: String, default: "", trim: true },
      },
      // Compatibility fields for older clients. They mirror bestServicedBy.
      nextIdealServicePeriod: { type: String, default: "", trim: true },
      nextIdealServiceDate: { type: Date, default: null },
      lastCalculatedAt: { type: Date, default: null },
      routineMaintenance: {
        bestServicedBy: { type: Date, default: null },
        recommendedService: { type: String, enum: ["", "regular_cleaning", "deep_cleaning"], default: "" },
        recommendationBasis: { type: String, default: "", trim: true },
        predictionSource: { type: String, enum: ["system", "openai"], default: "system" },
        intervalDays: { type: Number, default: 180, min: 30, max: 730 },
      },
      visitFollowUp: {
        analysisVersion: { type: Number, default: 0, min: 0 },
        sourceServiceHistoryId: { type: String, default: "", trim: true },
        provider: { type: String, enum: ["", "openai", "system-fallback"], default: "" },
        currentStatus: { type: String, default: "", trim: true },
        technicianRecorded: { type: String, default: "", trim: true },
        previousVisitHistory: [{ type: String, trim: true }],
        currentIssues: [{ type: String, trim: true }],
        completedWork: [{ type: String, trim: true }],
        severity: { type: String, enum: ["", "routine", "monitor", "soon", "urgent", "critical"], default: "" },
        riskType: { type: String, default: "", trim: true },
        predictedRisk: { type: String, default: "", trim: true },
        affectedComponent: { type: String, default: "", trim: true },
        overallCondition: { type: String, default: "", trim: true },
        componentConcern: { type: String, default: "", trim: true },
        evidenceConfidence: { type: String, enum: ["", "low", "medium", "high"], default: "" },
        recommendationMode: { type: String, enum: ["", "condition_based", "routine", "fallback"], default: "" },
        repairOrReplacement: { type: String, default: "", trim: true },
        recommendedPart: { type: String, default: "", trim: true },
        partRecommendationStatus: { type: String, default: "", trim: true },
        inventoryMessage: { type: String, default: "", trim: true },
        inventoryMatches: [{
          name: { type: String, default: "", trim: true },
          sku: { type: String, default: "", trim: true },
          companyStock: { type: Number, default: null },
          branchStock: { type: Number, default: null },
        }],
        recommendedService: { type: String, enum: ["", "regular_cleaning", "deep_cleaning", "inspection", "repair"], default: "" },
        recommendedFollowUpDays: { type: Number, default: null, min: 1, max: 365 },
        recommendedDate: { type: Date, default: null },
        aiAssessment: { type: String, default: "", trim: true },
        whyThisDate: { type: String, default: "", trim: true },
        customerSummary: { type: String, default: "", trim: true },
        recommendedActions: [{ type: String, trim: true }],
        generatedAt: { type: Date, default: null },
      },
    },

    warranty: {
      policyVersion: { type: String, default: "" },
      partsExpirationDate: { type: Date, default: null },
      compressorExpirationDate: { type: Date, default: null },
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
          status: { type: String, enum: ["submitted", "under_review", "approved", "rejected", "service_completed", "cancelled"], default: "submitted" },
          cancellationReason: { type: String, default: "", trim: true },
          requestedAt: { type: Date, default: Date.now },
          reviewedAt: { type: Date, default: null },
          resolvedAt: { type: Date, default: null },
          reviewerName: { type: String, default: "", trim: true },
          coveredComponent: { type: String, enum: ["", "parts", "compressor"], default: "" },
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
unitSchema.index({ status: 1, "amp.bestServicedBy": 1 });
unitSchema.index({ status: 1, "amp.recommendedService": 1 });

unitSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Unit", unitSchema);
