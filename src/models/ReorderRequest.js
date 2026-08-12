const mongoose = require("mongoose");

const reorderRequestSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: { type: Number, required: true },
    branch: { type: String, default: "", index: true },
    status: { type: String, enum: ["submitted", "approved", "rejected"], default: "submitted" },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

reorderRequestSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ReorderRequest", reorderRequestSchema);

