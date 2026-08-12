const mongoose = require("mongoose");

const partsRequestSchema = new mongoose.Schema(
  {
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    technicianName: { type: String, default: "", trim: true },
    branch: { type: String, default: "", index: true },
    taskId: { type: String, default: "", trim: true },
    partName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true },
    priority: { type: String, enum: ["Normal", "Urgent"], default: "Normal" },
    status: {
      type: String,
      enum: ["Submitted", "Reviewed", "Assigned", "Completed", "Cancelled"],
      default: "Submitted",
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewNote: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

partsRequestSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("PartsRequest", partsRequestSchema);
