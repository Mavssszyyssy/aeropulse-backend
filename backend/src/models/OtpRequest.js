const mongoose = require("mongoose");

const otpRequestSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: "", trim: true },
    challengeId: { type: String, default: "", trim: true },
    email: { type: String, default: "" },
    action: { type: String, required: true },
    channel: { type: String, required: true },
    codeHash: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

otpRequestSchema.index({ email: 1, action: 1, channel: 1 });
otpRequestSchema.index({ accountId: 1, action: 1, channel: 1, requestedAt: -1 });
otpRequestSchema.index({ accountId: 1, challengeId: 1, action: 1, requestedAt: -1 });
otpRequestSchema.index({ action: 1, channel: 1, requestedAt: -1 });
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OtpRequestV3", otpRequestSchema);
