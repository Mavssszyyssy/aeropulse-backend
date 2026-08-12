const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["account", "order", "system"], default: "system", index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    route: { type: String, default: "" },
    targetId: { type: String, default: "" },
    status: { type: String, enum: ["unread", "read"], default: "unread", index: true },
    unread: { type: Boolean, default: true },
  },
  { timestamps: true }
);

notificationSchema.pre("save", function syncUnreadStatus(next) {
  this.$locals.wasNew = this.isNew;
  if (this.isModified("status") && !this.isModified("unread")) {
    this.unread = this.status !== "read";
  }
  if (this.isModified("unread") && !this.isModified("status")) {
    this.status = this.unread ? "unread" : "read";
  }
  if (!this.status) {
    this.status = this.unread ? "unread" : "read";
  }
  next();
});

notificationSchema.post("save", function sendPushForNewNotification(doc) {
  if (!doc.$locals?.wasNew) return;
  // A push delivery problem must never block the action that created the alert.
  require("../services/pushNotificationService")
    .sendPushForNotification(doc)
    .catch((error) => console.warn("Failed to send notification push:", error.message));
});

notificationSchema.post("insertMany", function sendPushForInsertedNotifications(docs) {
  for (const doc of docs || []) {
    require("../services/pushNotificationService")
      .sendPushForNotification(doc)
      .catch((error) => console.warn("Failed to send notification push:", error.message));
  }
});

notificationSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Notification", notificationSchema);
