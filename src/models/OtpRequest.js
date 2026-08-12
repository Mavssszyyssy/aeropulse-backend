const mongoose = require("mongoose");

/**
 * OTP REQUEST MODEL V3
 * Renamed to OtpRequestV3 to force Mongoose to bypass the stuck/cached model
 * that was throwing stale enum validation errors.
 */
const otpRequestSchema = new mongoose.Schema(
  {
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    messenger_handle: { type: String, default: "" },
    action: { type: String, required: true },
    channel: { type: String, required: true },
    codeHash: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

otpRequestSchema.index({ email: 1, action: 1, channel: 1 });
otpRequestSchema.index({ phone: 1, action: 1, channel: 1 });
otpRequestSchema.index({ messenger_handle: 1, action: 1, channel: 1 });

// We use a unique model name to bypass any global Mongoose caching issues
module.exports = mongoose.model("OtpRequestV3", otpRequestSchema);
