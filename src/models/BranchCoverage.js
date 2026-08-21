const mongoose = require("mongoose");

const branchCoverageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    active: { type: Boolean, default: true },
    // Normalized location names served by this branch. Super Admins manage
    // these values; routing never silently assigns an unmatched address.
    coverageAreas: [{ type: String, trim: true, lowercase: true }],
    nearbyBranches: [{ type: String, trim: true }],
  },
  { timestamps: true },
);

module.exports = mongoose.model("BranchCoverage", branchCoverageSchema);
