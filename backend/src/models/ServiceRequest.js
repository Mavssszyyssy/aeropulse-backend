const mongoose = require("mongoose");

const serviceRequestSchema = new mongoose.Schema(
  {
    customer: { type: String, required: true, trim: true },
    issue: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    branch: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: ["Pending", "Submitted", "Reviewed", "Assigned", "In Progress", "Completed", "Cancelled"],
      default: "Pending",
      index: true,
    },
    customerId: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    unitId: { type: String, default: "" },
    unitName: { type: String, default: "" },
    issueType: { type: String, default: "" },
    assignedTechnicianId: { type: String, default: "" },
    assignedTechnicianName: { type: String, default: "" },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    servicePayment: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    idempotencyKey: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

serviceRequestSchema.index(
  { createdBy: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
serviceRequestSchema.index({ unitId: 1, createdAt: -1 });
serviceRequestSchema.index({ customerId: 1, createdAt: -1 });
serviceRequestSchema.index({ createdBy: 1, createdAt: -1 });
serviceRequestSchema.index({ branch: 1, createdAt: -1 });
serviceRequestSchema.index({ branch: 1, status: 1, createdAt: -1 });
serviceRequestSchema.index({ branch: 1, assignedTechnicianId: 1, createdAt: -1 });

serviceRequestSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ServiceRequest", serviceRequestSchema);

