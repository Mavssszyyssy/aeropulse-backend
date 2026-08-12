const mongoose = require("mongoose");

const serviceRequestSchema = new mongoose.Schema(
  {
    customer: { type: String, required: true, trim: true },
    issue: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    branch: { type: String, default: "", index: true },
    status: { type: String, default: "Pending" },
    customerId: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    unitId: { type: String, default: "" },
    unitName: { type: String, default: "" },
    issueType: { type: String, default: "" },
    assignedTechnicianId: { type: String, default: "" },
    assignedTechnicianName: { type: String, default: "" },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

serviceRequestSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ServiceRequest", serviceRequestSchema);

