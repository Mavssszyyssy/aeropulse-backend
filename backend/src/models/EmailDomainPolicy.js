const mongoose = require("mongoose");

const emailDomainEntrySchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, trim: true, lowercase: true },
    enabled: { type: Boolean, default: true },
    source: { type: String, enum: ["default", "custom"], default: "custom" },
  },
  { _id: false },
);

const emailDomainPolicySchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "global" },
    domains: { type: [emailDomainEntrySchema], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("EmailDomainPolicy", emailDomainPolicySchema);
