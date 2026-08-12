const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    role: { type: String, default: "" },
    status: {
      type: String,
      enum: ["present", "late", "on-site", "remote", "leave", "absent"],
      required: true,
    },
    branch: { type: String, default: "", index: true },
    notes: { type: String, default: "", trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

attendanceSchema.index({ user: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("Attendance", attendanceSchema);
