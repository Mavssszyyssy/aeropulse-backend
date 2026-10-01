const mongoose = require("mongoose");

const timelineEventSchema = new mongoose.Schema(
  {
    status: { type: String, default: "new" },
    note: { type: String, default: "", trim: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "", trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const contactMessageSchema = new mongoose.Schema(
  {
    ticketCode: { type: String, required: true, unique: true, index: true, trim: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customerName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, default: "", trim: true, lowercase: true, maxlength: 180 },
    phone: { type: String, default: "", trim: true, maxlength: 30 },
    category: {
      type: String,
      enum: ["general", "product", "order", "service", "warranty", "consultation", "other"],
      default: "general",
      index: true,
    },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 3000 },
    branch: { type: String, default: "", trim: true, index: true },
    source: { type: String, enum: ["web", "mobile"], default: "web" },
    status: {
      type: String,
      enum: ["new", "in_progress", "resolved", "closed"],
      default: "new",
      index: true,
    },
    adminReply: { type: String, default: "", trim: true, maxlength: 3000 },
    repliedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    timeline: { type: [timelineEventSchema], default: [] },
    idempotencyKey: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

contactMessageSchema.index(
  { customer: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);
contactMessageSchema.index({ branch: 1, status: 1, createdAt: -1 });
contactMessageSchema.index({ customer: 1, createdAt: -1 });

contactMessageSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("ContactMessage", contactMessageSchema);
