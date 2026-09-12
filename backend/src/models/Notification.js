const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["account", "order", "system", "inventory", "technician", "delivery", "service", "warranty", "payment", "security", "report"],
      default: "system",
      index: true,
    },
    branch: { type: String, default: "", index: true },
    category: { type: String, default: "", index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info", index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    route: { type: String, default: "" },
    targetId: { type: String, default: "" },
    targetType: { type: String, default: "" },
    // Dedupe keys are set by operational events. They make webhook retries,
    // repeated status saves, and browser polling safe without hiding distinct
    // business events.
    dedupeKey: { type: String, default: "", index: true },
    status: { type: String, enum: ["unread", "read"], default: "unread", index: true },
    unread: { type: Boolean, default: true },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// Mongoose 9 treats middleware without a returned promise as synchronous and
// no longer supplies the legacy `next` callback to this hook. Keeping the
// hook synchronous also guarantees notification failures cannot interrupt the
// order or technician workflow with `next is not a function`.
notificationSchema.pre("save", function syncUnreadStatus() {
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
});

notificationSchema.post("save", async function sendPushForNewNotification(doc) {
  if (!doc.$locals?.wasNew) return;
  // Await the attempt so a serverless runtime cannot terminate it early.
  // Delivery failures still cannot fail the action that saved the alert.
  try {
    await require("../services/pushNotificationService").sendPushForNotification(doc);
  } catch (error) {
    console.warn("Failed to send notification push:", error.message);
  }
});

notificationSchema.post("insertMany", async function sendPushForInsertedNotifications(docs) {
  await Promise.all((docs || []).map(async (doc) => {
    try {
      await require("../services/pushNotificationService").sendPushForNotification(doc);
    } catch (error) {
      console.warn("Failed to send notification push:", error.message);
    }
  }));
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
