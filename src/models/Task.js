const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    taskCode: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    customer: { type: String, required: true },
    address: { type: String, required: true },
    customerId: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    unitId: { type: String, default: "" },
    unitName: { type: String, default: "" },
    unitType: { type: String, default: "" },
    issueType: { type: String, default: "" },
    description: { type: String, default: "" },
    assignedTechnicianId: { type: String, default: "", index: true },
    assignedTechnicianName: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "on-the-way",
        "arrived",
        "installing",
        "in-progress",
        "on-hold",
        "failed",
        "rescheduled",
        "cancelled",
        "completed",
      ],
      default: "pending",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    scheduledDate: { type: String, required: true },
    timeSlot: { type: String, required: true },
    assignedRole: { type: String, default: "technician" },
    branch: { type: String, default: "", index: true },
    completedAt: { type: Date, default: null },
    proof: {
      beforePhotos: { type: [mongoose.Schema.Types.Mixed], default: [] },
      afterPhotos: { type: [mongoose.Schema.Types.Mixed], default: [] },
      // Customer identity is copied from the assigned order. It is not a
      // technician-entered acknowledgement or signature.
      customer: { type: mongoose.Schema.Types.Mixed, default: {} },
      customerSignature: { type: mongoose.Schema.Types.Mixed, default: {} },
      technicianName: { type: String, default: "" },
      submittedAt: { type: Date, default: null },
      notes: { type: String, default: "" },
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

taskSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

taskSchema.index({ branch: 1, updatedAt: -1 });
taskSchema.index({ "payload.orderCode": 1, updatedAt: -1 });

module.exports = mongoose.model("Task", taskSchema);
