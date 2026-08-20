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
        "order_lifecycle_updated",
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

const executiveAlertActions = new Set([
  "inventory_change_approved",
  "inventory_change_rejected",
  "inventory_direct_update",
  "restock_order_created",
  "restock_order_signalled",
  "restock_order_received",
  "restock_order_cancelled",
  "product_created",
  "product_deleted",
  "order_refund_review_updated",
]);

// Audit records are the authoritative source for high-impact back-office
// changes. Mirror only selected actions to SuperAdmin so routine activity
// remains in the audit log instead of turning the notification bell noisy.
auditLogSchema.post("save", function notifyExecutiveInbox(doc) {
  if (!executiveAlertActions.has(String(doc.action || ""))) return;
  const { notifyOperationalStaff } = require("../services/operationalNotificationService");
  const actionLabel = String(doc.action || "").replace(/_/g, " ");
  const isInventory = /inventory|restock|product/.test(String(doc.action || ""));
  notifyOperationalStaff({
    branch: doc.branch || "",
    title: isInventory ? "Inventory activity requires review" : "Important transaction activity",
    message: doc.description || `Recorded ${actionLabel}.`,
    type: isInventory ? "inventory" : "order",
    category: "audit",
    severity: /rejected|cancelled|refund/.test(String(doc.action || "")) ? "warning" : "info",
    targetId: String(doc.entityId || ""),
    targetType: isInventory ? "inventory" : "order",
    dedupeKey: `audit:${doc.action}:${doc.entityId}`,
    roles: ["superadmin"],
  }).catch((error) => console.warn("Failed to mirror audit alert:", error.message));
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
