const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "inventory_change_requested",
        "inventory_change_approved",
        "inventory_change_rejected",
        "inventory_direct_update",
        "restock_order_created",
        "restock_order_signalled",
        "restock_order_received",
        "restock_order_cancelled",
        "product_created",
        "product_updated",
        "product_deleted",
        "low_stock_alert",
        "user_registered",
        "user_login",
        "order_refund_review_updated",
        "order_cancellation_requested",
      ],
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    branch: {
      type: String,
      default: "",
      index: true,
    },
    entityType: {
      type: String,
      enum: ["product", "inventory_change_request", "restock_order", "user", "order"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    changeDetails: {
      before: mongoose.Schema.Types.Mixed,
      after: mongoose.Schema.Types.Mixed,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    ipAddress: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

auditLogSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
