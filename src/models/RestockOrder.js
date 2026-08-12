const mongoose = require("mongoose");

const restockOrderSchema = new mongoose.Schema(
  {
    supplier: {
      name: { type: String, required: true, trim: true },
      contact: { type: String, default: "", trim: true },
      email: { type: String, default: "", trim: true },
      phone: { type: String, default: "", trim: true },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    branches: {
      type: [String],
      required: true,
    },
    products: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
        },
        receivedQuantity: {
          type: Number,
          default: 0,
        },
      },
    ],
    expectedDeliveryStart: {
      type: Date,
      required: true,
    },
    expectedDeliveryEnd: {
      type: Date,
      required: true,
    },
    actualDeliveryDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending_signal", "incoming", "received", "cancelled"],
      default: "pending_signal",
      index: true,
    },
    signalledAt: {
      type: Date,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    cancellationReason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

restockOrderSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("RestockOrder", restockOrderSchema);
